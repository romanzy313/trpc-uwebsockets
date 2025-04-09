import { TRPCClientError } from '@trpc/client';
import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { EventEmitter } from 'events';

import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest';
import { z } from 'zod';
import { testFactory } from './___testHelpers';

import { type CreateContextOptions } from './requestHandler';
import { TRPCRequestInfo } from '@trpc/server/unstable-core-do-not-import';

async function createContext({ req, res, info, client }: CreateContextOptions) {
  const user = { name: req.headers.get('username') || 'anonymous' };

  await new Promise((resolve) => setTimeout(resolve, 10));

  if (info.url?.searchParams.get('throw')) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: info.url!.searchParams.get('throw')!,
    });
  }

  // for websocket context throwing after connection
  if (info.connectionParams?.throw) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: info.connectionParams?.throw,
    });
  }

  // test writing headers inside the context
  if (info.type === 'query') {
    res.cork(() => {
      res.writeHeader('x-test', 'true');
    });
  }
  return { req, res, user, info, client };
}

interface Message {
  id: string;
}

function createAppRouter() {
  const ee = new EventEmitter();
  const onNewMessageSubscription = vi.fn();
  const onSubscriptionEnded = vi.fn();

  const t = initTRPC.create();
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
        text: `hello ${input?.username ?? (ctx as any).user?.name ?? 'world'}`,
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
        if ((ctx as any).user.name === 'anonymous') {
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
    pubSub: publicProcedure.input(z.null()).subscription(({ ctx }) => {
      // TODO: fix all these
      const anyContext = ctx as any;
      if (!anyContext.client) {
        throw new Error('assertion: client should never be null in websockets');
      }
      const client = anyContext.client!;
      // for some reason client.publish does not work...
      // currently okay is false, not sure why uWs behaves this way
      // publishing from the server works though
      // app.server.publish('topic', 'created2');
      const okCreated = client.publish('topic', 'created');
      // console.log('publishing created to topic result', okCreated);

      const sub = observable<Message>((emit) => {
        emit.next({
          id: 'message',
        });
        setTimeout(() => {
          emit.complete();
        }, 50);
        return () => {
          const okEnded = client.publish('topic', 'ended');
          // console.log('publishing ended to topic result', okEnded);
        };
      });

      return sub;
    }),
    waitForMs: publicProcedure.input(z.number()).subscription(({ input }) => {
      const sub = observable<Message>((emit) => {
        setTimeout(() => {
          emit.complete();
        }, input);
        return () => {};
      });

      return sub;
    }),
    request: router({
      info: publicProcedure.query(({ ctx }) => {
        return (ctx as any).info as TRPCRequestInfo;
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

let stopFn = () => {};

afterEach(() => {
  stopFn();
});

function defaultFactory(config?: {
  createContext?: (opts: CreateContextOptions) => Promise<any>;
}) {
  const router = createAppRouter();

  const factoryVal = testFactory({
    appRouter: router.appRouter,
    createContext: config?.createContext ?? createContext,
  });

  stopFn = factoryVal.stop;

  return {
    ...router,
    ...factoryVal,
  };
}

describe('server', () => {
  test('fetch GET smoke', async () => {
    const ctx = defaultFactory();

    const res = await ctx.fetch(`/hello`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    // body should be object
    expect(await res.text()).toEqual('Hello world');
  });

  test('forwards response meta', async () => {
    const ctx = defaultFactory();
    const res = await ctx.fetch(`/trpc/ping?input=${encodeURI('{}')}`, {});
    expect(res.status).toEqual(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toEqual('*'); // from the meta
    expect(res.headers.get('x-test')).toEqual('true'); // from the context
  });

  test('query', async () => {
    const ctx = defaultFactory();
    const clients = [
      ctx.clientBatchStream().client,
      ctx.clientBatch().client,
      ctx.clientWs().client,
    ];

    for (const client of clients) {
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
    const ctx = defaultFactory();
    const clients = [
      ctx.clientBatchStream().client,
      ctx.clientBatch().client,
      ctx.clientWs().client,
    ];

    for (const client of clients) {
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

  test('subscription', { timeout: 5000 }, async () => {
    const ctx = defaultFactory();
    const ee = ctx.ee;
    const clients = [ctx.clientSse().client, ctx.clientWs().client];

    for (const client of clients) {
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

      ee.emit('server:msg', {
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
        expect(ee.listenerCount('server:msg')).toBe(0);
        expect(ee.listenerCount('server:error')).toBe(0);
      });
    }
  });

  test('streaming', async () => {
    const ctx = defaultFactory();
    const tests = [ctx.clientBatchStream(), ctx.clientWs()];

    for (const { client, orderedResults } of tests) {
      const results = await Promise.all([
        client.deferred.query({ wait: 3 }),
        client.deferred.query({ wait: 1 }),
        client.deferred.query({ wait: 2 }),
      ]);
      expect(results).toEqual([3, 1, 2]);
      expect(orderedResults).toEqual([1, 2, 3]);
    }
  });

  test('batched requests', async () => {
    const ctx = defaultFactory();
    const clients = [
      ctx.clientBatchStream().client,
      ctx.clientBatch().client,
      ctx.clientWs().client,
    ];

    for (const client of clients) {
      const res = await Promise.all([
        client.helloMutation.mutate('world'),
        client.helloMutation.mutate('KATT'),
      ]);
      expect(res).toEqual(['hello world', 'hello KATT']);
    }
  });

  test('handles throwing context', async () => {
    const ctx = defaultFactory();
    const clientOpts = {
      queryParams: {
        throw: 'expected_context_error',
      },
    };
    const clients = [
      ctx.clientBatchStream(clientOpts).client,
      ctx.clientBatch(clientOpts).client,
    ];

    for (const client of clients) {
      await expect(
        client.echo.query('hii')
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[TRPCClientError: expected_context_error]`
      );
    }

    // websocket context resolution failure hides the message
    const wsClient = ctx.clientWs(clientOpts).client;
    await expect(
      wsClient.echo.query('hii')
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[TRPCClientError: Unknown error]`
    );
  });

  test('handles throwing procedure', async () => {
    const ctx = defaultFactory();
    const clients = [
      ctx.clientBatchStream().client,
      ctx.clientBatch().client,
      ctx.clientWs().client,
    ];

    for (const client of clients) {
      await expect(
        client.throw.query('expected_procedure_error')
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[TRPCClientError: expected_procedure_error]`
      );
    }
  });

  // TODO: sse does not propogate the error?
  test('handles throwing subscription', async () => {
    const ctx = defaultFactory();
    // const clients = [server.clientWs(), server.clientSse()];
    // const clients = [server.clientSse()];
    const clients = [ctx.clientWs()];

    for (const { client, orderedResults } of clients) {
      // const spy = vi.fn();
      let error: TRPCClientError<any> | null = null;
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
        expect(orderedResults).toEqual([0, 1, 2, 3, 4]);
        expect(ctx.onServerErrorSpy).toBeCalledTimes(1);
        // SSE, this is not propogated
        expect(error!.message).toEqual(new TRPCClientError('5').message);
      });
    }
  });
});

describe('websocket', () => {
  test('does not bind other websocket connection', async () => {
    const ctx = defaultFactory();
    const client = new WebSocket(`ws://localhost:${ctx.port}/ws`);
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

  test('properly passes context', async () => {
    const contextDone = vi.fn();
    const ctx = defaultFactory({
      createContext: async ({ req, res, info, client }) => {
        expect(client != null);
        expect(res != null);
        expect(client).equals(res);

        // can still get the removeAddress from res
        // hopefully this stays constant in ci?
        const ip = new TextDecoder().decode(res.getRemoteAddressAsText());
        expect(ip).equals('127.0.0.1');

        // but other res-like features are not possible
        expect('writeHeader' in res).equals(false);

        contextDone();

        return { req, res, info, client };
      },
    });
    const client = ctx.clientWs().client;
    await client.echo.query('testing');

    expect(contextDone).toHaveBeenCalledOnce();
  });

  test('handles throwing context with connection params', async () => {
    const server = defaultFactory();
    let closeCode: number | undefined = undefined;
    const { client } = server.clientWs({
      wsClientOptions: {
        connectionParams: {
          throw: 'expected_context_error',
        },
        onClose(cause) {
          closeCode = cause?.code;
        },
        onError(cause) {
          console.warn('on error called', cause);
        },
      },
    });

    await expect(
      client.echo.query('hi')
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[TRPCClientError: Unknown error]`
    );

    await vi.waitFor(() => {
      expect(closeCode).toEqual(1008);
    });
  });
  test('handles throwing context without connection params', async () => {
    const server = defaultFactory();
    let closeCode: number | undefined = undefined;
    const { client } = server.clientWs({
      queryParams: {
        throw: 'expected_context_error',
      },
      wsClientOptions: {
        onClose(cause) {
          closeCode = cause?.code;
        },
      },
    });

    await expect(
      client.echo.query('hi')
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[TRPCClientError: Unknown error]`
    );

    await vi.waitFor(() => {
      expect(closeCode).toEqual(1008);
    });
  });

  test('keep alive', async () => {
    const ctx = defaultFactory();
    let closeCode: number | undefined = undefined;
    const { client, wsClient } = ctx.clientWs({
      wsClientOptions: {
        onClose(cause) {
          closeCode = cause?.code;
        },
        keepAlive: {
          enabled: true,
          intervalMs: 100,
          pongTimeoutMs: 200,
        },
      },
    });
    const { unsubscribe } = client.waitForMs.subscribe(2_000, {});
    await vi.waitFor(() => {
      expect(wsClient.connection!.state).toBe('open');
    });
    let pongCount = 0;
    wsClient.connection!.ws!.addEventListener('message', (ev) => {
      if (ev.data === 'PONG') {
        pongCount++;
      }
    });
    await vi.waitFor(
      () => {
        expect(pongCount).toEqual(4);
        expect(closeCode).toEqual(undefined);
      },
      {
        timeout: 2_000,
      }
    );
    unsubscribe();
    wsClient.close();
    await vi.waitFor(() => {
      expect(closeCode).toEqual(1005);
    });
  });
  //   // for some reason client.publish does not work, even though it should
  //   test('uWebsockets pubsub', { skip: true }, async () => {
  //     const clientWs = new WebSocket(`ws://localhost:${app.port}/pubsub`);
  //     const messages: string[] = [];
  //     let connected = false;
  //     clientWs.onmessage = (ev) => {
  //       console.log('triggered onmessage', ev.data);
  //       messages.push(JSON.parse(ev.data));
  //     };
  //     clientWs.onerror = () => {
  //       throw new Error('client had an error');
  //     };
  //     clientWs.onopen = () => {
  //       connected = true;
  //     };
  //     await vi.waitFor(() => {
  //       expect(connected).toBe(true);
  //     });
  //     expect(app.server.numSubscribers('topic')).toBe(1);
  //     const { client } = app.clientWs();
  //     const sub = client.pubSub.subscribe(null, {
  //       onData(data) {
  //         console.log('trpc onMessage', data);
  //         expectTypeOf(data).not.toBeAny();
  //         expectTypeOf(data).toMatchTypeOf<Message>();
  //         messages.push(data.id);
  //       },
  //     });
  //     await vi.waitFor(() => {
  //       expect(messages).toEqual(['created', 'message', 'ended']);
  //     });
  //     sub.unsubscribe();
  //     clientWs.close();
  //   });
});
