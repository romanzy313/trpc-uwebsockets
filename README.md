# trpc-uwebsockets

[uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) adapter for [tRPC version 11](https://trpc.io/). Use [v10 branch](https://github.com/romanzy313/trpc-uwebsockets/tree/v10) for version 10.

# Installation

```bash
npm install trpc-uwebsockets
```

The versioning of the adapter follows the versioning scheme of trpc. For example, for the `@trpc/server` version of `11.0.0`, the npm package for `trpc-uwebsockets` will have version `11.0.X`, where X is incrementing library version. Ensure that the version of `@trpc/server` and `@trpc/client` matches the version of `trpc-uwebsockets`. Your package manager should provide warnings such as "incorrect peer dependency" if something is wrong.

```bash
npm install uNetworking/uWebSockets.js#v20.51.0
```

Installation of uWebSockets.js must be done separately, as it is a peer dependency of the project. Version 20.51.0 or higher is required.

# Usage

This full example can be found [here](src/readme.spec.ts).

```ts
import * as uWs from 'uWebSockets.js';
import { initTRPC } from '@trpc/server';
import z from 'zod';

import {
  applyRequestHandler,
  applyWebsocketHandler,
  CreateContextOptions,
} from 'trpc-uwebsockets';

/* Define context. During websocket connection do not use `res`, use `client` instead */
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
```

# Client example

```ts
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
```

# Acknowledgements

Big thanks to [Ahoy Labs](https://github.com/ahoylabs) for sponsoring the development of this project!

<!-- # TODOS:
 - Make test "aborted requests are handled" less flaky
 - Skipped test "uWebsockets pubsub" doesn't work as intended... But usage of built-in pubsub is not needed with trpc  -->

<!-- Publishing notes:
Set env variable `YARN_NPM_AUTH_TOKEN` before running `yarn publish:main`
 -->
