// README code starts below. replace import from './index' with 'trpc-uwebsockets'

// README SERVER START
import * as uWs from 'uWebSockets.js';
import { initTRPC } from '@trpc/server';
import {
  applyRequestHandler,
  applyWebsocketHandler,
  CreateContextOptions,
} from './index';
import z from 'zod';

// define server port. Value of 0 means that random port will be used
let port = 0;

// define context. client is available when websocket connection is used
function createContext({ req, res, info, client }: CreateContextOptions) {
  const user = { name: req.headers.get('username') || 'anonymous' };
  return { req, res, user, info, client };
}
type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

// define app router
const appRouter = t.router({
  hello: t.procedure
    .input(
      z
        .object({
          username: z.string().nullish(),
        })
        .nullish()
    )
    .query(
      ({ input, ctx }) =>
        `hello ${input?.username ?? ctx.user?.name ?? 'world'}`
    ),

  count: t.procedure
    .input(
      z.object({
        from: z.number(),
        count: z.number(),
      })
    )
    .subscription(async function* ({ input, ctx, signal }) {
      // client on context is guaranteed to be not null:
      // ctx.client!.publish('topic', 'message')

      for (let i = input.from; i < input.from + input.count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (signal?.aborted) {
          return;
        }
        yield i;
      }
    }),
});
export type AppRouter = typeof appRouter;

// create uWebSockets server and attach trpc to it
const app = uWs.App();

// handle cors
app.options('/*', (res) => {
  res.writeHeader('Access-Control-Allow-Origin', '*');
  res.endWithoutBody();
});

applyRequestHandler(app, {
  prefix: '/trpc',
  ssl: false,
  trpcOptions: {
    router: appRouter,
    createContext,
    onError(data) {
      // or send error to monitoring service
      console.error('trpc error', data);
    },
    responseMeta() {
      // attach additional headers on each response
      return {
        headers: {
          'Access-Control-Allow-Origin': '*',
        },
      };
    },
  },
});

// add websockets support
applyWebsocketHandler(app, {
  prefix: '/trpc',
  router: appRouter,
  createContext,
});

/* dont crash on unknown request */
app.any('/*', (res) => {
  res.writeStatus('404 NOT FOUND');
  res.end();
});

// wait for server to start
const stopServer = await new Promise<() => void>((resolve, reject) => {
  app.listen('0.0.0.0', port, (socket) => {
    if (socket === false) {
      return reject(new Error(`Server failed to listen on port ${port}`));
    }
    port = uWs.us_socket_local_port(socket);
    resolve(() => {
      uWs.us_listen_socket_close(socket);
    });
  });
});
// README SERVER END

// README CLIENT START
import { vi, test, expect, afterAll } from 'vitest';

import {
  createTRPCClient,
  createWSClient,
  splitLink,
  unstable_httpBatchStreamLink,
  wsLink,
} from '@trpc/client';

// close the server after the test
afterAll(() => {
  stopServer();
});

// configure TRPCClient to use WebSockets and BatchStreaming transport
const client = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      condition(op) {
        return op.type === 'subscription';
      },
      true: wsLink({
        client: createWSClient({
          url: `ws://localhost:${port}/trpc`,
        }),
      }),
      false: unstable_httpBatchStreamLink({
        url: `http://localhost:${port}/trpc`,
      }),
    }),
  ],
});

test('query', async () => {
  expect(await client.hello.query()).toEqual('hello anonymous');
  expect(
    await client.hello.query({
      username: 'trpc',
    })
  ).toEqual('hello trpc');
});

test('subscription', async () => {
  const results: number[] = [];
  let done = false;
  client.count.subscribe(
    { from: 3, count: 5 },
    {
      onData(value) {
        results.push(value);
      },
      onStopped() {
        done = true;
      },
    }
  );

  await vi.waitFor(() => {
    expect(done).toBe(true);
  });

  expect(results).toEqual([3, 4, 5, 6, 7]);
});
// README CLIENT END
