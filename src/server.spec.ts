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
} from '@trpc/client';
import type { HTTPHeaders, TRPCLink } from '@trpc/client';
import { initTRPC } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { EventSourcePolyfill } from 'event-source-polyfill';
import { z } from 'zod';

import {
  type UWsHandlerOptions,
  type CreateUWsContextOptions,
  createUWebSocketsHandler,
} from './requestHandler';
import { applyWebsocketsHandler } from './websockets';

const config = {
  prefix: '/trpc',
};

function createContext({ req, res, info }: CreateUWsContextOptions) {
  const user = { name: req.headers.get('username') || 'anonymous' };

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

  createUWebSocketsHandler(instance, {
    // useWSS: true, // TODO
    prefix: config.prefix,
    useWebsockets: true,
    trpcOptions: {
      router,
      createContext,
      onError(data) {
        console.error('trpc error', data);
      },
      responseMeta({ ctx, paths, type, errors }) {
        return {
          headers: {
            'Access-Control-Allow-Origin': '*',
          },
        };
      },
    } satisfies UWsHandlerOptions<AppRouter>['trpcOptions'],
  });
  applyWebsocketsHandler(instance, {
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
  headers?: HTTPHeaders;
  port: number;
}

type ClientType = 'batchStreamWs' | 'batch' | 'sse';

function createClientBatchStreamWs(opts: ClientOptions) {
  const host = `localhost:${opts.port}${config.prefix}`;
  const wsClient = createWSClient({ url: `ws://${host}` });
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
  const host = `localhost:${opts.port}${config.prefix}`;
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
  const host = `localhost:${opts.port}${config.prefix}`;
  const client = createTRPCClient<AppRouter>({
    links: [
      // loggerLink(),
      unstable_httpSubscriptionLink({
        url: `http://${host}`,
        // ponyfill EventSource
        EventSource: EventSourcePolyfill,
      }),
    ],
  });
  return { client };
}

interface AppOptions {
  clientOptions?: Partial<ClientOptions>;
  serverOptions?: Partial<ServerOptions>;
}

async function createApp(opts: AppOptions = {}) {
  const { appRouter, ee } = createAppRouter();
  const { instance, port, stop } = createServer({
    ...(opts.serverOptions ?? {}),
    appRouter,
  });

  return {
    server: instance,
    stop,
    getClient(clientType: ClientType) {
      switch (clientType) {
        case 'batchStreamWs':
          return createClientBatchStreamWs({
            ...opts.clientOptions,
            port,
          }).client;
        case 'batch':
          return createClientBatch({
            ...opts.clientOptions,
            port,
          }).client;
        case 'sse':
          return createClientSSE({
            ...opts.clientOptions,
            port,
          }).client;
        default:
          throw new Error('unknown client');
      }
    },
    ee,
    port,
    opts,
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
    const req = await fetch(`http://localhost:${app.port}/hello`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    // body should be object
    expect(await req.text()).toEqual('Hello world');
  });

  test('response meta', async () => {
    const fetcher = await fetch(
      `http://localhost:${app.port}/trpc/ping?input=${encodeURI('{}')}`
    );
    expect(fetcher.status).toEqual(200);
    expect(fetcher.headers.get('Access-Control-Allow-Origin')).toEqual('*'); // from the meta
    expect(fetcher.headers.get('x-test')).toEqual('true'); // from the context
  });

  // Vitest limitation...
  // Error: InlineSnapshot cannot be used inside of test.each or describe.each
  // https://github.com/vitest-dev/vitest/issues/3329
  // therefore tests will be duplicated unfortunately
  // test.each<ClientType>(['batchStreamWs'])(
  //   'query - %name',
  //   async (clientType) => {
  //     const client = app.getClient(clientType);
  //     expect(await client.ping.query()).toMatchInlineSnapshot(`"pong"`);
  //     expect(await client.hello.query()).toMatchInlineSnapshot(`
  //         Object {
  //           "text": "hello anonymous",
  //         }
  //     `);
  //     expect(
  //       await client.hello.query({
  //         username: 'test',
  //       })
  //     ).toMatchInlineSnapshot(`
  //         Object {
  //           "text": "hello test",
  //         }
  //     `);
  //   }
  // );

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
});
