/* eslint-disable @typescript-eslint/no-explicit-any */
import AbortController from 'abort-controller';
import fetch from 'node-fetch';
import { UWebSocketsCreateContextOptions } from '../src/types';
import uWs from 'uWebSockets.js';
import z from 'zod';
import * as trpc from '@trpc/server';
import { inferAsyncReturnType, TRPCError } from '@trpc/server';
import { createUWebSocketsHandler } from '../src/index';
import { createTRPCClient, HTTPHeaders } from '@trpc/client';

const testPort = 8799;

function makeRouter() {
  const router = trpc
    .router<Context>()
    .query('hello', {
      input: z
        .object({
          who: z.string().nullish(),
        })
        .nullish(),
      resolve({ input, ctx }) {
        return {
          text: `hello ${input?.who ?? ctx.user?.name ?? 'world'}`,
        };
      },
    })
    .query('error', {
      resolve() {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'error as expected',
        });
      },
    })
    .mutation('test', {
      input: z.object({
        value: z.string(),
      }),
      resolve({ input, ctx }) {
        return {
          originalValue: input.value,
          user: ctx.user,
        };
      },
    })
    .query('cookie-monster', {
      resolve({ input, ctx }) {
        const cookies = ctx.req.getCookies();

        const combined = cookies['cookie1'] + cookies['cookie2'];
        ctx.res.setCookie('one', 'nom');
        ctx.res.setCookie('two', 'nom nom');
        ctx.res.setHeader('x-spooked', 'true');
        ctx.res.setStatus(201);
        return {
          combined,
          user: ctx.user,
        };
      },
    });

  return router;
}
export type Router = ReturnType<typeof makeRouter>;

function makeContext() {
  const createContext = ({
    req,
    res,
    uWs,
  }: UWebSocketsCreateContextOptions) => {
    const getUser = () => {
      if (req.headers.authorization === 'meow') {
        return {
          name: 'KATT',
        };
      }
      if (req.getCookies()?.user === 'romanzy')
        return {
          name: 'romanzy',
        };
      return null;
    };

    return {
      req,
      res,
      uWs,
      user: getUser(),
    };
  };

  return createContext;
}
export type Context = inferAsyncReturnType<ReturnType<typeof makeContext>>;
async function startServer() {
  const app = uWs.App();

  // Handle CORS
  app.options('/trpc/*', (res) => {
    res.writeHeader('Access-Control-Allow-Origin', '*');
    res.writeStatus('200 OK');
    res.end();
  });

  app.get('/', (res) => {
    res.writeStatus('200 OK');

    res.end();
  });

  // need to register everything on the app object,
  // as uWebSockets does not have middleware
  createUWebSocketsHandler(app, '/trpc', {
    onRequest: (req, res) => {
      // allows for prerequest handling
      const origin = req.headers.origin ?? '*';
      res.setHeader('Access-Control-Allow-Origin', origin);
    },
    router: makeRouter(),
    createContext: makeContext(),
  });

  app.put('/trpc/put', (res) => {
    res.writeStatus('204');
    res.end();
  });

  app.any('/*', (res) => {
    res.writeStatus('404 NOT FOUND');
    res.end();
  });

  const { socket } = await new Promise<{
    socket: uWs.us_listen_socket;
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
          resolve();
        } catch (error) {
          reject();
        }
      }),
  };
}

function makeClient(headers) {
  return createTRPCClient<Router>({
    url: `http://localhost:${testPort}/trpc`,

    AbortController: AbortController as any,
    fetch: fetch as any,
    headers,
  });
}

let t!: trpc.inferAsyncReturnType<typeof startServer>;
beforeEach(async () => {
  t = await startServer();
});
afterEach(async () => {
  await t.close();
});

test('simple query', async () => {
  // t.client.runtime.headers = ()
  const client = makeClient({});

  expect(
    await client.query('hello', {
      who: 'test',
    })
  ).toMatchInlineSnapshot(`
    Object {
      "text": "hello test",
    }
  `);

  expect(client.query('error', null)).rejects.toThrowError('error as expected');
});

test('mutation with header', async () => {
  const client = makeClient({
    authorization: 'meow',
  });

  expect(
    await client.mutation('test', {
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

// Error status codes are correct
test('reads cookies', async () => {
  const client = makeClient({
    cookie: 'cookie1=abc; cookie2=d.e; user=romanzy',
  });

  expect(await client.query('cookie-monster')).toMatchInlineSnapshot(`
    Object {
      "combined": "abcd.e",
      "user": Object {
        "name": "romanzy",
      },
    }
  `);
});

test('setting cookies and headers', async () => {
  const monsterRes = await fetch(
    `http://localhost:${testPort}/trpc/cookie-monster`
  );
  expect(monsterRes.status).toEqual(201);
  expect(monsterRes.headers.get('set-cookie')).toEqual(
    'one=nom, two=nom%20nom'
  );
  expect(monsterRes.headers.get('x-spooked')).toEqual('true');
});

test('error handling', async () => {
  const indexRes = await fetch(`http://localhost:${testPort}`);
  expect(indexRes.status).toEqual(200);

  const putRes = await fetch(`http://localhost:${testPort}/trpc/put`, {
    method: 'PUT',
  });
  expect(putRes.status).toEqual(204);

  const badInput = '{"who": "test';
  const badRes = await fetch(
    `http://localhost:${testPort}/trpc/hello?input=${badInput}`
  );
  expect(badRes.status).toEqual(400);

  const badPath = await fetch(
    `http://localhost:${testPort}/trpc/nonexisting?input=${badInput}`
  );
  expect(badPath.status).toEqual(400);

  const uncaught = await fetch(`http://localhost:${testPort}/badurl`);

  expect(uncaught.status).toEqual(404);
});
