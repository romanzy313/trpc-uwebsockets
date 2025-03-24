// README code starts below. replace import from './index' with 'trpc-uwebsockets'

// README SERVER START
import * as uWs from 'uWebSockets.js';
import { initTRPC } from '@trpc/server';
import z from 'zod';

import {
  applyRequestHandler,
  applyWebsocketHandler,
  CreateContextOptions,
} from './index';

/* Define context. `client` is available when websocket connection is used */
function createContext({ req, res, info, client }: CreateContextOptions) {
  const user = { name: req.headers.get('username') || 'anonymous' };
  return { req, res, user, info, client };
}
type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

/* Define app router */
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
      z
        .object({
          from: z.number().positive(),
          to: z.number().positive(),
        })
        .superRefine(({ from, to }, ctx) => {
          if (to < from) {
            ctx.addIssue({
              code: 'custom',
              message: "'to' must be bigger then 'from'",
            });
          }
        })
    )
    .subscription(async function* ({ input, signal }) {
      for (let i = input.from; i <= input.to; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (signal?.aborted) {
          return;
        }
        yield i;
      }
    }),
});
export type AppRouter = typeof appRouter;

/* Create uWebSockets server */
const app = uWs.App();

/* Handle CORS */
app.options('/*', (res) => {
  res.writeHeader('Access-Control-Allow-Origin', '*');
  res.endWithoutBody();
});

/* Attach main tRPC event handler */
applyRequestHandler(app, {
  prefix: '/trpc',
  ssl: false /* set to true if your application is served over HTTPS */,
  trpcOptions: {
    router: appRouter,
    createContext,
    onError(data) {
      console.error('trpc error:', data);
    },
    responseMeta() {
      return {
        headers: {
          'Access-Control-Allow-Origin': '*',
        },
      };
    },
  },
});

/* Add websockets support */
applyWebsocketHandler(app, {
  prefix: '/trpc',
  router: appRouter,
  createContext,
});

/* Don't crash on undefined requests */
app.any('/*', (res) => {
  res.writeStatus('404 NOT FOUND');
  res.end();
});

type Server = {
  stop: () => void;
  port: number;
};

async function startServer(port: number): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    app.listen('0.0.0.0', port, (socket) => {
      if (socket === false) {
        return reject(new Error(`Server failed to listen on port ${port}`));
      }
      resolve({
        stop: () => uWs.us_listen_socket_close(socket),
        port: uWs.us_socket_local_port(socket),
      });
    });
  });
}

// README SERVER END

// README CLIENT START
import { vi, test, expect, beforeEach, afterEach } from 'vitest';

import {
  createTRPCClient,
  createWSClient,
  splitLink,
  httpBatchStreamLink,
  wsLink,
} from '@trpc/client';

let server: Server;

beforeEach(async () => {
  // Zero port means that a random port will be used
  server = await startServer(0);
});
afterEach(() => {
  server.stop();
});

/* Configure TRPCClient to use WebSockets and BatchStreaming transport */
function makeClient() {
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition(op) {
          return op.type === 'subscription';
        },
        true: wsLink({
          client: createWSClient({
            url: `ws://localhost:${server.port}/trpc`,
          }),
        }),
        false: httpBatchStreamLink({
          url: `http://localhost:${server.port}/trpc`,
        }),
      }),
    ],
  });
}

test('query', async () => {
  const client = makeClient();

  expect(await client.hello.query()).toEqual('hello anonymous');
  expect(
    await client.hello.query({
      username: 'trpc',
    })
  ).toEqual('hello trpc');
});

test('subscription', async () => {
  const client = makeClient();

  const results: number[] = [];
  let done = false;
  client.count.subscribe(
    { from: 3, to: 7 },
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
