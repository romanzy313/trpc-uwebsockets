/* eslint-disable @typescript-eslint/no-explicit-any */
import fetch from 'node-fetch';
import { CreateContextOptions } from '../src/types';
import uWs from 'uWebSockets.js';
import z from 'zod';
import { createUWebSocketsHandler } from '../src/index';
import {
  createTRPCProxyClient,
  httpBatchLink,
} from '@trpc/client';
import { inferAsyncReturnType, initTRPC, TRPCError } from '@trpc/server';

const testPort = 8799;

function makeRouter() {
  const t = initTRPC.context<Context>().create();

  const router = t.router({
    hello: t.procedure
      .input(
        z
          .object({
            who: z.string().nullish(),
          })
          .nullish()
      )
      .query(({ input, ctx }) => {
        return {
          text: `hello ${input?.who ?? ctx.user?.name ?? 'world'}`,
        };
      }),
    error: t.procedure.query(() => {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'error as expected',
      });
    }),
    test: t.procedure
      .input(
        z.object({
          value: z.string(),
        })
      )
      .mutation(({ input, ctx }) => {
        return {
          originalValue: input.value,
          user: ctx.user,
        };
      }),
    manualRes: t.procedure.query(({ ctx }) => {
      ctx.res.writeStatus('400');
      ctx.res.writeHeader('manual', 'header');
      ctx.res.writeHeader('set-cookie', 'lala=true');
      ctx.res.writeHeader('set-cookie', 'anotherone=false');
      // ctx.res.
      return 'status 400';
    }),
  });
  return router;
}
export type Router = ReturnType<typeof makeRouter>;

function makeContext() {
  const createContext = ({ req, res }: CreateContextOptions) => {
    const getUser = () => {
      if (req.headers.authorization === 'meow') {
        return {
          name: 'KATT',
        };
      }
      return null;
    };
    return {
      req,
      res,
      // uWs,
      user: getUser(),
    };
  };

  return createContext;
}
export type Context = inferAsyncReturnType<ReturnType<typeof makeContext>>;

// export type Context = inferAsyncReturnType<ReturnType<typeof makeContext>>;
async function startServer() {
  const app = uWs.App();

  createUWebSocketsHandler(app, '/trpc', {
    
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    responseMeta({ ctx, paths, type, errors }) {
      return {
        headers: {
          hello: 'world',
        },
      };
    },
    router: makeRouter(),
    createContext: makeContext(),
  });

  let { socket } = await new Promise<{
    socket: uWs.us_listen_socket | any;
  }>((resolve) => {
    app.listen('0.0.0.0', testPort, (socket) => {
      resolve({
        socket,
      });
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        try {
          uWs.us_listen_socket_close(socket);
          socket = null;
          resolve();
        } catch (error) {
          reject();
        }
      }),
  };
}

function makeClient(headers) {
  const client = createTRPCProxyClient<Router>({
    links: [
      httpBatchLink({
        url: `http://localhost:${testPort}/trpc`,
        fetch: fetch as any,
        headers,
      }),
    ],
  });
  return client;
  // client.

  // return createTRPCClient<Router>({
  //   url: `http://localhost:${testPort}/trpc`,

  //   AbortController: AbortController as any,
  //   fetch: fetch as any,
  //   headers,
  // });
}

let t!: Awaited<ReturnType<typeof startServer>>;
beforeEach(async () => {
  t = await startServer();
});
afterEach(async () => {
  await t.close();
});

test('query simple success and error handling', async () => {
  // t.client.runtime.headers = ()
  const client = makeClient({});

  // client.
  expect(
    await client.hello.query({
      who: 'test',
    })
  ).toMatchInlineSnapshot(`
    Object {
      "text": "hello test",
    }
  `);

  await expect(client.error.query()).rejects.toThrowError('error as expected');
});

test('mutation and reading headers', async () => {
  const client = makeClient({
    authorization: 'meow',
  });

  expect(
    await client.test.mutate({
      value: 'lala',
    })
  ).toMatchInlineSnapshot(`
    Object {
      "originalValue": "lala",
      "user": Object {
        "name": "KATT",
      },
    }
  `);
});

test('manually sets status and headers', async () => {
  const fetcher = await fetch(
    `http://localhost:${testPort}/trpc/manualRes?input=${encodeURI('{}')}`
  );
  const body = await fetcher.json();
  expect(fetcher.status).toEqual(400);
  expect(body.result.data).toEqual('status 400');

  expect(fetcher.headers.get('hello')).toEqual('world'); // from the meta
  expect(fetcher.headers.get('manual')).toEqual('header'); //from the result
});

// this needs to be tested
// test('abort works okay', async () => {
//   const ac = new AbortController();
//   const client = makeClient({});

//   setTimeout(() => {
//     ac.abort();
//   }, 3);
//   const res = await client.test.mutate(
//     {
//       value: 'haha',
//     },
//     {
//       signal: ac.signal as any,
//     }
//   );

//   expect(res).toMatchInlineSnapshot(`
//     Object {
//       "originalValue": "haha",
//       "user": null,
//     }
// 	`);
// });
