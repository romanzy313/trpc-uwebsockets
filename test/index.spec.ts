import { vi, beforeEach, afterEach, test, expect, expectTypeOf } from 'vitest';
// idk how to use that
// import { waitFor } from '@testing-library/dom';

import fetch from 'node-fetch';
import { CreateContextOptions } from '../src/types';
import uWs from 'uWebSockets.js';
import z from 'zod';
import { createUWebSocketsHandler } from '../src/index';
import {
  createTRPCProxyClient,
  createWSClient,
  httpBatchLink,
  splitLink,
  TRPCLink,
  // unstable_httpBatchStreamLink,
  wsLink,
} from '@trpc/client';
import { inferAsyncReturnType, initTRPC, TRPCError } from '@trpc/server';
import EventEmitter from 'events';

import { observable } from '@trpc/server/observable';
import ws from 'ws';

const testPort = 8799;

interface Message {
  id: string;
}
// TODO test middleware?
const ee = new EventEmitter();
function makeRouter() {
  const onNewMessageSubscription = vi.fn();
  const onSubscriptionEnded = vi.fn();

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
    onMessage: t.procedure.input(z.string()).subscription(() => {
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
  });
  return router;
}
export type AppRouter = ReturnType<typeof makeRouter>;

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
    enableSubscriptions: true,
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
  const host = `localhost:${testPort}/trpc`;
  const wsClient = createWSClient({
    url: `ws://${host}`,
    WebSocket: ws as any,
  });
  const client = createTRPCProxyClient<AppRouter>({
    links: [
      linkSpy,
      splitLink({
        condition(op) {
          return op.type === 'subscription';
        },
        true: wsLink({ client: wsClient }),
        false: httpBatchLink({
          url: `http://${host}`,
          headers: headers,
          AbortController,
          fetch: fetch as any,
        }),
        // false: unstable_httpBatchStreamLink({
        //   url: `http://${host}`,
        //   headers: headers,
        //   AbortController,
        //   fetch: fetch as any,
        // }),
      }),
    ],
  });
  return {
    client,
    wsClient,
  };

}

let t!: Awaited<ReturnType<typeof startServer>>;
beforeEach(async () => {
  t = await startServer();
});
afterEach(async () => {
  await t.close();
  ee.removeAllListeners();
});

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
          orderedResults.push((value.result as any).data);
          observer.next(value);
        },
        error: observer.error,
      });
      return unsubscribe;
    });
  };
};

test('query simple success and error handling', async () => {
  // t.client.runtime.headers = ()
  const { client } = makeClient({});

  // client.
  expect(
    await client.hello.query({
      who: 'test',
    })
  ).toMatchInlineSnapshot(`
    {
      "text": "hello test",
    }
  `);

  await expect(client.error.query()).rejects.toThrowError('error as expected');
});

test('mutation and reading headers', async () => {
  const { client } = makeClient({
    authorization: 'meow',
  });

  expect(
    await client.test.mutate({
      value: 'lala',
    })
  ).toMatchInlineSnapshot(`
    {
      "originalValue": "lala",
      "user": {
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
test('abording requests works', async () => {
  const ac = new AbortController();
  const { client } = makeClient({});

  expect.assertions(1);

  setTimeout(() => {
    ac.abort();
  });

  try {
    await client.test.mutate(
      {
        value: 'haha',
      },
      {
        signal: ac.signal as any,
      }
    );
  } catch (error) {
    expect(error.name).toBe('TRPCClientError');
  }
});

test('subscription only operation', async () => {
  const host = `localhost:${testPort}/trpc`;
  const wsClient = createWSClient({
    url: `ws://${host}`,
    WebSocket: ws as any,
    retryDelayMs: (i) => {
      console.log("retrying", i);
      return 200;
    }
  });

  const client = createTRPCProxyClient<AppRouter>({
    links: [wsLink({ client: wsClient })],
  });
  expect(
    await client.hello.query({
      who: 'test',
    })
  ).toMatchInlineSnapshot(`
    {
      "text": "hello test",
    }
  `);
  await expect(client.error.query()).rejects.toThrowError('error as expected');


});

// FIXME no idea how to make it non-flaky
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Source: https://github.com/trpc/trpc/blob/main/packages/tests/server/adapters/fastify.test.ts
test(
  'ugly subscription tests',
  async () => {
    ee.once('subscription:created', () => {
      setTimeout(() => {
        ee.emit('server:msg', {
          id: '1',
        });
        ee.emit('server:msg', {
          id: '2',
        });
      });
    });

    const { client } = makeClient({});

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

    // onStartedMock.

    // expect(onStartedMock).toh

    await sleep(500); // FIXME how to use waitFor instead?
    expect(onStartedMock).toHaveBeenCalledTimes(1);
    expect(onDataMock).toHaveBeenCalledTimes(2);
    // await waitFor(() => {
    //   expect(onStartedMock).toHaveBeenCalledTimes(1);
    //   expect(onDataMock).toHaveBeenCalledTimes(2);
    // });

    ee.emit('server:msg', {
      id: '3',
    });
    await sleep(500);
    expect(onDataMock).toHaveBeenCalledTimes(3);

    // await waitFor(() => {
    //   expect(onDataMock).toHaveBeenCalledTimes(3);
    // });

    expect(onDataMock.mock.calls).toMatchInlineSnapshot(`
    [
      [
        {
          "id": "1",
        },
      ],
      [
        {
          "id": "2",
        },
      ],
      [
        {
          "id": "3",
        },
      ],
    ]
  `);

    sub.unsubscribe();

    await sleep(500);

    expect(ee.listenerCount('server:msg')).toBe(0);
    expect(ee.listenerCount('server:error')).toBe(0);
  },
  {
    timeout: 10000,
  }
);


