# trpc-uwebsockets

[uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) adapter for [tRPC version 11](https://trpc.io/). Use [master branch](https://github.com/romanzy313/trpc-uwebsockets/tree/master) for version 10.

# Installation

Install the latest release candidate version with

```bash
npm install trpc-uwebsockets@next
```

The versioning of the adapter follows the versioning scheme of trpc. For example, for the `@trpc/server` version of `11.0.0-rc.730`, the npm package for `trpc-uwebsockets` will have version `11.0.0-rc.730.X`, where X is incrementing library version. Ensure that the version of `@trpc/server` and `@trpc/client` matches the version of `trpc-uwebsockets`.

# Usage

This full example can be found [here](src/readme.spec.ts).

```ts
import * as uWs from 'uWebSockets.js';
import { initTRPC } from '@trpc/server';
import {
  applyRequestHandler,
  applyWebsocketHandler,
  CreateContextOptions,
} from 'trpc-uwebsockets';
import z from 'zod';

/* define context. `client` is available for websocket connections */
function createContext({ req, res, info, client }: CreateContextOptions) {
  const user = { name: req.headers.get('username') || 'anonymous' };
  return { req, res, user, info, client };
}
type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

/* define app router */
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

/* create uWebSockets server */
const app = uWs.App();

/* handle cors */
app.options('/*', (res) => {
  res.writeHeader('Access-Control-Allow-Origin', '*');
  res.endWithoutBody();
});

/* attach main trpc event handler */
applyRequestHandler(app, {
  prefix: '/trpc',
  ssl: false /* set to true if server is using https or is behind a reverse proxy */,
  trpcOptions: {
    router: appRouter,
    createContext,
    onError(data) {
      /* or send error to monitoring services */
      console.error('trpc error', data);
    },
    responseMeta() {
      /* attach additional headers on each response */
      return {
        headers: {
          'Access-Control-Allow-Origin': '*',
        },
      };
    },
  },
});

/* add websockets support */
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
```

# Client example

```ts
import { vi, test, expect, beforeEach, afterEach } from 'vitest';

import {
  createTRPCClient,
  createWSClient,
  splitLink,
  unstable_httpBatchStreamLink,
  wsLink,
} from '@trpc/client';

let server: Server;

beforeEach(async () => {
  /* zero port means that random port will be used */
  server = await startServer(0);
});
afterEach(() => {
  server.stop();
});

/* configure TRPCClient to use WebSockets and BatchStreaming transport */
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
        false: unstable_httpBatchStreamLink({
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
```

# Acknowledgements

Big thanks to [Ahoy Labs](https://github.com/ahoylabs) for sponsoring the development of this project!

<!-- # TODOS:
 - Make test "aborted requests are handled" less flaky
 - Skipped test "uWebsockets pubsub" doesn't work as intended... But usage of built-in pubsub is not needed with trpc  -->
