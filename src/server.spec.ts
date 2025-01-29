import {
  vi,
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
  expectTypeOf,
} from 'vitest';
import uWs from 'uWebSockets.js';
import { EventEmitter } from 'events';
import {
  createTRPCClient,
  loggerLink,
  createWSClient,
  httpBatchLink,
  splitLink,
  unstable_httpBatchStreamLink,
  unstable_httpSubscriptionLink,
  wsLink,
  TRPCClientError,
} from '@trpc/client';
import type { HTTPHeaders, TRPCLink } from '@trpc/client';
import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { EventSourcePolyfill } from 'event-source-polyfill';
import { z } from 'zod';

import {
  type CreateContextOptions,
  applyRequestHandler,
  CreateHandlerOptions,
} from './requestHandler';
import { applyWebsocketHandler } from './websockets';
import { TRPCRequestInfo } from '@trpc/server/http';

const config = {
  prefix: '/trpc',
};

function createContext({ req, res, info }: CreateContextOptions) {
  const user = { name: req.headers.get('username') || 'anonymous' };

  if (req.headers.has('throw')) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: req.headers.get('throw')!,
    });
    // throw new Error(req.headers.get('throw')!);
  }

  // for websocket context setting after connection
  if (info.connectionParams?.throw) {
    console.log('connection param is throwing', info.connectionParams?.throw);
    // throw new Error(info.connectionParams?.throw);

    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: info.connectionParams?.throw,
    });
  }

  // for websocket context setting during connection
  const url = new URL(req.url);
  if (url.searchParams.has('throw')) {
    throw new Error(url.searchParams.get('throw')!);
  }
  // filter out so that this is not triggered during subscription
  // but really, responseMeta should be used instead!
  if (info.type === 'query') {
    res.writeHeader('x-test', 'true');
  }
  return { req, res, user, info };
}

type Context = Awaited<ReturnType<typeof createContext>>;

interface Message {
  id: string;
}

function createAppRouter() {
  const ee = new EventEmitter();
  const onNewMessageSubscription = vi.fn();
  const onSubscriptionEnded = vi.fn();

  const t = initTRPC.context<Context>().create();
  const router = t.router;
  const publicProcedure = t.procedure;

  const appRouter = router({
    ping: publicProcedure.query(() => {
      return 'pong';
    }),
    echo: publicProcedure.input(z.string()).query(({ input }) => {
      return input;
    }),
    hello: publicProcedure
      .input(
        z
          .object({
            username: z.string().nullish(),
          })
          .nullish()
      )
      .query(({ input, ctx }) => ({
        text: `hello ${input?.username ?? ctx.user?.name ?? 'world'}`,
      })),
    helloMutation: publicProcedure
      .input(z.string())
      .mutation(({ input }) => `hello ${input}`),
    editPost: publicProcedure
      .input(
        z.object({
          id: z.string(),
          data: z.object({
            title: z.string(),
            text: z.string(),
          }),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.name === 'anonymous') {
          return { error: 'Unauthorized user' };
        }
        const { id, data } = input;
        return { id, ...data };
      }),
    onMessage: publicProcedure.input(z.string()).subscription(() => {
      const sub = observable<Message>((emit) => {
        const onMessage = (data: Message) => {
          emit.next(data);
        };
        ee.on('server:msg', onMessage);
        return () => {
          onSubscriptionEnded();
          ee.off('server:msg', onMessage);
        };
      });
      ee.emit('subscription:created');
      onNewMessageSubscription();
      return sub;
    }),
    request: router({
      info: publicProcedure.query(({ ctx }) => {
        return ctx.info;
      }),
    }),
    deferred: publicProcedure
      .input(
        z.object({
          wait: z.number(),
        })
      )
      .query(async (opts) => {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, opts.input.wait * 10)
        );
        return opts.input.wait;
      }),
    throw: t.procedure.input(z.string()).query(({ input }) => {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: input,
      });
    }),
    count: t.procedure
      .input(
        z.object({
          from: z.number(),
          count: z.number(),
          throw: z.number().optional(),
        })
      )
      .subscription(async function* ({ input, signal }) {
        for (let i = input.from; i < input.from + input.count; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (signal?.aborted) {
            return;
          }
          if (input.throw === i) {
            throw new Error(i.toString());
          }
          yield i;
        }
      }),
  });

  return { appRouter, ee, onNewMessageSubscription, onSubscriptionEnded };
}

type CreateAppRouter = Awaited<ReturnType<typeof createAppRouter>>;
type AppRouter = CreateAppRouter['appRouter'];

interface ServerOptions {
  appRouter: AppRouter;
  // fastifyPluginWrapper?: boolean;
  // withContentTypeParser?: boolean;
}

function createServer(opts: ServerOptions) {
  const instance = uWs.App();

  const router = opts.appRouter;

  applyRequestHandler(instance, {
    // useWSS: true, // TODO
    prefix: config.prefix,
    trpcOptions: {
      router,
      createContext,
      onError(data) {
        // console.error('trpc error', data);
      },
      responseMeta({ ctx, paths, type, errors }) {
        return {
          headers: {
            'Access-Control-Allow-Origin': '*',
          },
        };
      },
    } satisfies CreateHandlerOptions<AppRouter>['trpcOptions'],
  });
  applyWebsocketHandler(instance, {
    prefix: config.prefix,
    router,
    createContext,
  });

  instance.get('/hello', async (res, req) => {
    res.end('Hello world');
  });
  instance.post('/hello', async (res, req) => {
    res.end(JSON.stringify({ hello: 'POST', body: 'TODO, why?' }));
  });

  instance.ws('/ws', {
    message: (client, rawMsg) => {
      client.send(rawMsg);
    },
  });

  instance.any('/*', (res, req) => {
    res.writeStatus('404 NOT FOUND');
    res.end();
  });

  let socket: uWs.us_listen_socket | false | null = null;

  instance.listen('0.0.0.0', 0, (token) => {
    socket = token;
  });

  if (!socket) {
    throw new Error('could not make a socket');
  }

  const port = uWs.us_socket_local_port(socket);

  return {
    stop() {
      if (!socket) {
        throw new Error('could not close socket as socket is already closed');
      }
      uWs.us_listen_socket_close(socket);
      socket = null;
    },
    port,
    instance,
  };
}

const orderedResults: number[] = [];
const linkSpy: TRPCLink<AppRouter> = () => {
  // here we just got initialized in the app - this happens once per app
  // useful for storing cache for instance
  return ({ next, op }) => {
    // this is when passing the result to the next link
    // each link needs to return an observable which propagates results
    return observable((observer) => {
      const unsubscribe = next(op).subscribe({
        next(value) {
          orderedResults.push(value.result.data as number);
          observer.next(value);
        },
        error: observer.error,
      });
      return unsubscribe;
    });
  };
};

interface ClientOptions {
  connectionParams?: TRPCRequestInfo['connectionParams'];
  onError?: (evt?: Event) => void;
  queryParams?: Record<string, string>;
  headers?: HTTPHeaders;
  port: number;
}

function toQueryString(queryParams: Record<string, string>) {
  const raw = new URLSearchParams(queryParams).toString();
  return raw.length == 0 ? '' : `?${raw}`;
}

type ClientType = 'batchStreamWs' | 'batch' | 'sse';

function createClientBatchStreamWs(opts: ClientOptions) {
  const qs = toQueryString(opts.queryParams ?? {});
  const host = `localhost:${opts.port}${config.prefix}${qs}`;
  const wsClient = createWSClient({
    url: `ws://${host}`,
    onError: opts.onError,
    onClose: (asd) => {
      console.error('onClose was called', asd);
    },
    connectionParams: opts.connectionParams,
    retryDelayMs: () => 1000,
  });
  const client = createTRPCClient<AppRouter>({
    links: [
      linkSpy,
      // loggerLink(),
      splitLink({
        condition(op) {
          return op.type === 'subscription';
        },
        true: wsLink({ client: wsClient }),
        false: unstable_httpBatchStreamLink({
          url: `http://${host}`,
          headers: opts.headers,
        }),
      }),
    ],
  });

  return { client, wsClient };
}

function createClientBatch(opts: ClientOptions) {
  const qs = toQueryString(opts.queryParams ?? {});
  const host = `localhost:${opts.port}${config.prefix}${qs}`;
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `http://${host}`,
        headers: opts.headers,
      }),
    ],
  });

  return { client };
}

function createClientSSE(opts: ClientOptions) {
  const qs = toQueryString(opts.queryParams ?? {});
  const host = `localhost:${opts.port}${config.prefix}${qs}`;
  const client = createTRPCClient<AppRouter>({
    links: [
      // loggerLink(),
      unstable_httpSubscriptionLink({
        url: `http://${host}`,
        connectionParams: opts.connectionParams,
        // ponyfill EventSource
        EventSource: EventSourcePolyfill as any,
      }),
    ],
  });
  return { client };
}

async function createApp(serverOptions?: Partial<ServerOptions>) {
  const { appRouter, ee } = createAppRouter();
  const { instance, port, stop } = createServer({
    ...(serverOptions ?? {}),
    appRouter,
  });

  return {
    server: instance,
    stop,
    getClient(clientType: ClientType, clientOptions?: Partial<ClientOptions>) {
      switch (clientType) {
        case 'batchStreamWs':
          return createClientBatchStreamWs({
            ...clientOptions,
            port,
          }).client;
        case 'batch':
          return createClientBatch({
            ...clientOptions,
            port,
          }).client;
        case 'sse':
          return createClientSSE({
            ...clientOptions,
            port,
          }).client;
        default:
          throw new Error('unknown client');
      }
    },
    ee,
    port,
    opts: serverOptions,
  };
}

let app: Awaited<ReturnType<typeof createApp>>;

describe('server', () => {
  beforeEach(async () => {
    orderedResults.length = 0;
    app = await createApp();
  });

  afterEach(() => {
    app.stop();
  });

  test('fetch GET smoke', async () => {
    const res = await fetch(`http://localhost:${app.port}/hello`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    // body should be object
    expect(await res.text()).toEqual('Hello world');
  });

  test('response meta', async () => {
    const res = await fetch(
      `http://localhost:${app.port}/trpc/ping?input=${encodeURI('{}')}`
    );
    expect(res.status).toEqual(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toEqual('*'); // from the meta
    expect(res.headers.get('x-test')).toEqual('true'); // from the context
  });

  test('query', async () => {
    {
      const client = app.getClient('batchStreamWs');
      expect(await client.ping.query()).toMatchInlineSnapshot(`"pong"`);
      expect(await client.hello.query()).toMatchInlineSnapshot(`
          Object {
            "text": "hello anonymous",
          }
      `);
      expect(
        await client.hello.query({
          username: 'test',
        })
      ).toMatchInlineSnapshot(`
          Object {
            "text": "hello test",
          }
      `);
    }

    {
      const client = app.getClient('batch');
      expect(await client.ping.query()).toMatchInlineSnapshot(`"pong"`);
      expect(await client.hello.query()).toMatchInlineSnapshot(`
          Object {
            "text": "hello anonymous",
          }
      `);
      expect(
        await client.hello.query({
          username: 'test',
        })
      ).toMatchInlineSnapshot(`
          Object {
            "text": "hello test",
          }
      `);
    }
  });

  test('mutation', async () => {
    {
      const client = app.getClient('batchStreamWs');
      expect(
        await client.editPost.mutate({
          id: '42',
          data: { title: 'new_title', text: 'new_text' },
        })
      ).toMatchInlineSnapshot(`
      Object {
        "error": "Unauthorized user",
      }
    `);
    }

    {
      const client = app.getClient('batch');
      expect(
        await client.editPost.mutate({
          id: '42',
          data: { title: 'new_title', text: 'new_text' },
        })
      ).toMatchInlineSnapshot(`
      Object {
        "error": "Unauthorized user",
      }
    `);
    }
  });

  test('streaming', async () => {
    const client = app.getClient('batchStreamWs');
    const results = await Promise.all([
      client.deferred.query({ wait: 3 }),
      client.deferred.query({ wait: 1 }),
      client.deferred.query({ wait: 2 }),
    ]);
    expect(results).toEqual([3, 1, 2]);
    expect(orderedResults).toEqual([1, 2, 3]);
  });

  test('batched requests in body work correctly', async () => {
    {
      const client = app.getClient('batch');

      const res = await Promise.all([
        client.helloMutation.mutate('world'),
        client.helloMutation.mutate('KATT'),
      ]);
      expect(res).toEqual(['hello world', 'hello KATT']);
    }

    {
      const client = app.getClient('batchStreamWs');

      const res = await Promise.all([
        client.helloMutation.mutate('world'),
        client.helloMutation.mutate('KATT'),
      ]);
      expect(res).toEqual(['hello world', 'hello KATT']);
    }
  });

  test('does not bind other websocket connection', async () => {
    const client = new WebSocket(`ws://localhost:${app.port}/ws`);

    await new Promise<void>((resolve, reject) => {
      client.onopen = () => {
        client.send('hello');
        resolve();
      };
      client.onerror = reject;
    });

    const promise = new Promise<string>((resolve) => {
      client.onmessage = (msg) => {
        return resolve(msg.data);
      };
    });

    const message = await promise;

    expect(message.toString()).toBe('hello');

    client.close();
  });

  test('handles throwing procedure', async () => {
    const client = app.getClient('batchStreamWs');
    await expect(
      client.throw.query('expected_procedure_error')
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[TRPCClientError: expected_procedure_error]`
    );
  });

  test('handles throwing context', async () => {
    const client = app.getClient('batchStreamWs', {
      headers: {
        throw: 'expected_context_error',
      },
    });
    await expect(
      client.echo.query('hii')
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[TRPCClientError: expected_context_error]`
    );
  });

  // TODO: test failure of context as in v10

  test('subscription - websocket', async () => {
    const client = app.getClient('batchStreamWs');

    app.ee.once('subscription:created', () => {
      setTimeout(() => {
        app.ee.emit('server:msg', {
          id: '1',
        });
        app.ee.emit('server:msg', {
          id: '2',
        });
      });
    });

    const onStartedMock = vi.fn();
    const onDataMock = vi.fn();
    const sub = client.onMessage.subscribe('onMessage', {
      onStarted: onStartedMock,
      onData(data) {
        expectTypeOf(data).not.toBeAny();
        expectTypeOf(data).toMatchTypeOf<Message>();
        onDataMock(data);
      },
    });

    await vi.waitFor(() => {
      expect(onStartedMock).toHaveBeenCalledTimes(1);
      expect(onDataMock).toHaveBeenCalledTimes(2);
    });

    app.ee.emit('server:msg', {
      id: '3',
    });

    await vi.waitFor(() => {
      expect(onDataMock).toHaveBeenCalledTimes(3);
    });

    expect(onDataMock.mock.calls).toMatchInlineSnapshot(`
      Array [
        Array [
          Object {
            "id": "1",
          },
        ],
        Array [
          Object {
            "id": "2",
          },
        ],
        Array [
          Object {
            "id": "3",
          },
        ],
      ]
    `);

    sub.unsubscribe();

    await vi.waitFor(() => {
      expect(app.ee.listenerCount('server:msg')).toBe(0);
      expect(app.ee.listenerCount('server:error')).toBe(0);
    });
  });

  test('subscription - sse', { timeout: 5000 }, async () => {
    const client = app.getClient('sse');

    app.ee.once('subscription:created', () => {
      setTimeout(() => {
        app.ee.emit('server:msg', {
          id: '1',
        });
        app.ee.emit('server:msg', {
          id: '2',
        });
      });
    });

    const onStartedMock = vi.fn();
    const onDataMock = vi.fn();
    const sub = client.onMessage.subscribe('onMessage', {
      onStarted: onStartedMock,
      onData(data) {
        expectTypeOf(data).not.toBeAny();
        expectTypeOf(data).toMatchTypeOf<Message>();
        onDataMock(data);
      },
    });

    await vi.waitFor(
      () => {
        expect(onStartedMock).toHaveBeenCalledTimes(1);
        expect(onDataMock).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 }
    );

    app.ee.emit('server:msg', {
      id: '3',
    });

    await vi.waitFor(() => {
      expect(onDataMock).toHaveBeenCalledTimes(3);
    });

    expect(onDataMock.mock.calls).toMatchInlineSnapshot(`
      Array [
        Array [
          Object {
            "id": "1",
          },
        ],
        Array [
          Object {
            "id": "2",
          },
        ],
        Array [
          Object {
            "id": "3",
          },
        ],
      ]
    `);

    sub.unsubscribe();

    await vi.waitFor(() => {
      expect(app.ee.listenerCount('server:msg')).toBe(0);
      expect(app.ee.listenerCount('server:error')).toBe(0);
    });
  });

  test('subscription - handles throwing procedure', async () => {
    const client = app.getClient('batchStreamWs');

    let error: any = null;

    client.count.subscribe(
      {
        from: 0,
        count: 10,
        throw: 5,
      },
      {
        onError(err) {
          error = err;
        },
      }
    );

    await vi.waitFor(() => {
      expect(error).toEqual(new TRPCClientError('5'));
    });
  });

  // the current websocket client just keeps on trying to reconnect
  // no way to tell it to stop the reconnection
  // and it never raises an error that connection could not be established
  test('subscription - handles throwing context', async () => {
    let error: any = null;

    const client = app.getClient('batchStreamWs', {
      connectionParams: {
        throw: 'expected_context_error',
      },
      onError(evt) {
        error = evt;
      },
    });

    client.count.subscribe(
      {
        from: 0,
        count: 10,
      },
      {
        onError(err) {
          error = err;
        },
      }
    );

    await vi.waitFor(
      () => {
        console.log('error is', error);
        expect(error).toEqual(new TRPCClientError('expected_context_error'));
      },
      {
        timeout: 2000,
        interval: 1000,
      }
    );
  });
});
