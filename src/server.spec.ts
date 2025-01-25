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
// import fetch from 'node-fetch'; // why this again?
import { z } from 'zod';

import {
  type UWsTRPCPluginOptions,
  type CreateUWsContextOptions,
  uWsTRPCPlugin,
} from './uWsTRPCPlugin';

const config = {
  prefix: '/trpc',
};

function createContext({ req, res, info }: CreateUWsContextOptions) {
  const user = { name: req.getHeader('username') || 'anonymous' };
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

  uWsTRPCPlugin(instance, {
    // useWSS: true, // TODO
    prefix: config.prefix,
    trpcOptions: {
      router,
      createContext,
      onError(data) {
        // report to error monitoring
        // TODO: whats this???
        data;
        // ^?
      },
    } satisfies UWsTRPCPluginOptions<AppRouter>['trpcOptions'],
  });

  instance.get('/hello', async (res, req) => {
    res.end('Hello world');
  });
  instance.post('/hello', async (res, req) => {
    res.end(JSON.stringify({ hello: 'POST', body: 'TODO, why?' }));
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
  console.log('Listening to port ' + port);

  return {
    stop() {
      // donest need to be async, but for compat
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
      unstable_httpSubscriptionLink({
        url: `http://${host}`,
        // headers: opts.headers,
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
    // client: clientBatchStreamWs,
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
    // url,
    opts,
  };
}

let app: Awaited<ReturnType<typeof createApp>>;

describe('anonymous user', () => {
  beforeEach(async () => {
    orderedResults.length = 0;
    app = await createApp();
  });

  afterEach(() => {
    app.stop();
  });

  test('fetch GET smoke', async () => {
    console.log('request url', `http://localhost:${app.port}/hello`);
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

  // fetch post is not implemented yet...
  // test('fetch POST', async () => {
  //   const data = { text: 'life', life: 42 };
  //   const req = await fetch(`http://localhost:${app.url.port}/hello`, {
  //     method: 'POST',
  //     headers: {
  //       Accept: 'application/json',
  //       'Content-Type': 'application/json',
  //     },
  //     body: JSON.stringify(data),
  //   });
  //   // body should be object
  //   expect(await req.json()).toMatchInlineSnapshot(`
  //     Object {
  //       "body": Object {
  //         "life": 42,
  //         "text": "life",
  //       },
  //       "hello": "POST",
  //     }
  //   `);
  // });

  // Big L Error: InlineSnapshot cannot be used inside of test.each or describe.each
  test.each<ClientType>(['batchStreamWs'])(
    'query - %name',
    async (clientType) => {
      const client = app.getClient(clientType);
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
  );

  test.each<ClientType>(['batchStreamWs'])(
    'mutation - %name',
    async (clientType) => {
      const client = app.getClient(clientType);
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
  );

  // test('mutation', async () => {
  //   expect(
  //     await app.client.editPost.mutate({
  //       id: '42',
  //       data: { title: 'new_title', text: 'new_text' },
  //     })
  //   ).toMatchInlineSnapshot(`
  //     Object {
  //       "error": "Unauthorized user",
  //     }
  //   `);
  // });

  test('batched requests in body work correctly', async () => {
    const { client } = createClientBatch({
      ...app.opts.clientOptions,
      port: app.port,
    });

    const res = await Promise.all([
      client.helloMutation.mutate('world'),
      client.helloMutation.mutate('KATT'),
    ]);
    expect(res).toEqual(['hello world', 'hello KATT']);
  });

  // test('does not bind other websocket connection', async () => {
  //   const client = new WebSocket(`ws://localhost:${app.url.port}/ws`);

  //   await new Promise<void>((resolve, reject) => {
  //     client.once('open', () => {
  //       client.send('hello');
  //       resolve();
  //     });

  //     client.once('error', reject);
  //   });

  //   const promise = new Promise<string>((resolve) => {
  //     client.once('message', resolve);
  //   });

  //   const message = await promise;

  //   expect(message.toString()).toBe('hello');

  //   client.close();
  // });

  test.skip('subscription', async () => {
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
    const sub = app.client.onMessage.subscribe('onMessage', {
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
