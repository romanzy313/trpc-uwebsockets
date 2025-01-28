import type {
  HttpRequest,
  TemplatedApp,
  WebSocketBehavior,
  WebSocket,
} from 'uWebSockets.js';

type RemoveFunctions<T> = {
  // TODO: suppress eslint
  [K in keyof T as NonNullable<T[K]> extends Function ? never : K]: T[K];
};

export type WebSocketBehaviorOptions = RemoveFunctions<WebSocketBehavior<any>>;

import {
  type BaseHandlerOptions,
  type TRPCRequestInfo,
  parseConnectionParamsFromUnknown,
} from '@trpc/server/http';
import {
  type CreateContextCallback,
  type AnyRouter,
  TRPCError,
  inferRouterContext,
  transformTRPCResponse,
  callProcedure,
  getErrorShape,
  getTRPCErrorFromUnknown,
  isTrackedEnvelope,
} from '@trpc/server';
import {
  createURL,
  NodeHTTPCreateContextFnOptions,
} from '@trpc/server/adapters/node-http';
import {
  type MaybePromise,
  isAsyncIterable,
  isObject,
  run,
} from '@trpc/server/unstable-core-do-not-import';
import {
  type TRPCClientOutgoingMessage,
  type TRPCConnectionParamsMessage,
  type TRPCReconnectNotification,
  type TRPCResponseMessage,
  type TRPCResultMessage,
  parseTRPCMessage,
} from '@trpc/server/rpc';
import {
  decorateHttpResponse,
  HttpResponseDecorated,
  uWsToRequest,
} from './fetchCompat';
import {
  isObservable,
  observableToAsyncIterable,
} from '@trpc/server/observable';

// TODO: ask TRPC to expose these
// import { iteratorResource } from '@trpc/server/src/unstable-core-do-not-import/stream/utils/asyncIterable';
// import { Unpromise } from '@trpc/server/src/vendor/unpromise';
// copying over packages/server/src/adapters/ws.ts

/**
 * @public
 */
export type CreateWSSContextFnOptions = NodeHTTPCreateContextFnOptions<
  Request,
  HttpResponseDecorated
>;

export type CreateWSSContextFn<TRouter extends AnyRouter> = (
  opts: CreateWSSContextFnOptions
) => MaybePromise<inferRouterContext<TRouter>>;

export type WSConnectionHandlerOptions<TRouter extends AnyRouter> =
  BaseHandlerOptions<TRouter, Request> &
    CreateContextCallback<
      inferRouterContext<TRouter>,
      CreateWSSContextFn<TRouter>
    >;

/**
 * Web socket server handler
 */
export type WSSHandlerOptions<TRouter extends AnyRouter> =
  WSConnectionHandlerOptions<TRouter> & {
    // wss: ws.WebSocketServer;
    prefix?: string;
    keepAlive?: {
      /**
       * Enable heartbeat messages
       * @default false
       */
      enabled: boolean;
      /**
       * Heartbeat interval in milliseconds
       * @default 30_000
       */
      pingMs?: number;
      /**
       * Terminate the WebSocket if no pong is received after this many milliseconds
       * @default 5_000
       */
      pongWaitMs?: number;
    };
    /**
     * Disable responding to ping messages from the client
     * **Not recommended** - this is mainly used for testing
     * @default false
     */
    dangerouslyDisablePong?: boolean;
    uWsBehaviorOptions?: WebSocketBehaviorOptions;
  };

// data bound internally on each client
// this all is changed in newer versions
type Decoration = {
  req: Request;
  res: HttpResponseDecorated;
  clientSubscriptions: Map<number | string, AbortController>;
  abortController: AbortController;
  ctxPromise:
    | typeof unsetContextPromiseSymbol
    | Promise<inferRouterContext<AnyRouter>>
    | undefined; // undefined is needed so that context is set when connection is openned
  ctx: inferRouterContext<AnyRouter> | undefined; // TODO: chec kif untyped is okay?
};

const unsetContextPromiseSymbol = Symbol('unsetContextPromise');
export function getWSConnectionHandler<TRouter extends AnyRouter>(
  opts: WSSHandlerOptions<TRouter>,
  allClients: Set<WebSocket<Decoration>>
): WebSocketBehavior<Decoration> {
  const { createContext, router } = opts;
  const { transformer } = router._def._config;

  function respond(
    client: WebSocket<Decoration>,
    untransformedJSON: TRPCResponseMessage
  ) {
    client.send(
      JSON.stringify(
        transformTRPCResponse(router._def._config, untransformedJSON)
      )
    );
  }

  function createCtxPromise(
    client: WebSocket<Decoration>,
    getConnectionParams: () => TRPCRequestInfo['connectionParams']
  ): Promise<inferRouterContext<TRouter>> {
    const data = client.getUserData();
    return run(async () => {
      data.ctx = await createContext?.({
        req: data.req,
        // res: client, // OG
        res: data.res,
        info: {
          connectionParams: getConnectionParams(),
          calls: [],
          isBatchCall: false,
          accept: null,
          type: 'unknown',
          signal: data.abortController.signal,
        },
      });

      return data.ctx;
    }).catch((cause) => {
      const error = getTRPCErrorFromUnknown(cause);
      opts.onError?.({
        error,
        path: undefined,
        type: 'unknown',
        ctx: data.ctx,
        req: data.req,
        input: undefined,
      });
      respond(client, {
        id: null,
        error: getErrorShape({
          config: router._def._config,
          error,
          type: 'unknown',
          path: undefined,
          input: undefined,
          ctx: data.ctx,
        }),
      });

      // large timeout is needed in order for response above to reach the client
      // otherwise it tries to reconnect over and over again, even though the context throws
      // this is a rough edge of uWs
      setTimeout(() => {
        if (data.res.aborted) {
          return;
        }
        client.end();
      }, 1000);

      // original code
      // (global.setImmediate ?? global.setTimeout)(() => {
      // client.end()
      // });

      throw error;
    });
  }

  async function handleRequest(
    client: WebSocket<Decoration>,
    msg: TRPCClientOutgoingMessage
  ) {
    const { clientSubscriptions, ctx, ctxPromise, req, res } =
      client.getUserData();

    const { id, jsonrpc } = msg;

    /* istanbul ignore next -- @preserve */
    if (id === null) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: '`id` is required',
      });
    }
    if (msg.method === 'subscription.stop') {
      clientSubscriptions.get(id)?.abort();
      return;
    }
    const { path, lastEventId } = msg.params;
    let { input } = msg.params;
    const type = msg.method;
    try {
      if (lastEventId !== undefined) {
        if (isObject(input)) {
          input = {
            ...input,
            lastEventId: lastEventId,
          };
        } else {
          input ??= {
            lastEventId: lastEventId,
          };
        }
      }
      await ctxPromise; // asserts context has been set

      const abortController = new AbortController();
      const result = await callProcedure({
        procedures: router._def.procedures,
        path,
        getRawInput: async () => input,
        ctx,
        type,
        signal: abortController.signal,
      });

      const isIterableResult = isAsyncIterable(result) || isObservable(result);

      if (type !== 'subscription') {
        if (isIterableResult) {
          throw new TRPCError({
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: `Cannot return an async iterable or observable from a ${type} procedure with WebSockets`,
          });
        }
        // send the value as data if the method is not a subscription
        respond(client, {
          id,
          jsonrpc,
          result: {
            type: 'data',
            data: result,
          },
        });
        return;
      }

      if (!isIterableResult) {
        throw new TRPCError({
          message: `Subscription ${path} did not return an observable or a AsyncGenerator`,
          code: 'INTERNAL_SERVER_ERROR',
        });
      }

      if (res.aborted) {
        return;
      }

      /* istanbul ignore next -- @preserve */
      // if (client.readyState !== WEBSOCKET_OPEN) {
      //   // if the client got disconnected whilst initializing the subscription
      //   // no need to send stopped message if the client is disconnected

      //   return;
      // }

      /* istanbul ignore next -- @preserve */
      if (clientSubscriptions.has(id)) {
        // duplicate request ids for client

        throw new TRPCError({
          message: `Duplicate id ${id}`,
          code: 'BAD_REQUEST',
        });
      }

      const iterable = isObservable(result)
        ? observableToAsyncIterable(result, abortController.signal)
        : result;

      run(async () => {
        // await using iterator = iteratorResource(iterable);
        // for now do it like this:
        const iterator = iterable[Symbol.asyncIterator]();

        const abortPromise = new Promise<'abort'>((resolve) => {
          abortController.signal.onabort = () => resolve('abort');
        });
        // We need those declarations outside the loop for garbage collection reasons. If they
        // were declared inside, they would not be freed until the next value is present.
        let next:
          | null
          | TRPCError
          | Awaited<
              typeof abortPromise | ReturnType<(typeof iterator)['next']>
            >;
        let result: null | TRPCResultMessage<unknown>['result'];

        while (true) {
          // using the Promise.race could introduce memory leaks?
          // more on this here: https://github.com/cefn/watchable/tree/main/packages/unpromise
          // the trpc used Unpromise to accomplish this
          // next = await Unpromise.race([
          next = await Promise.race([
            iterator.next().catch(getTRPCErrorFromUnknown),
            abortPromise,
          ]);

          if (next === 'abort') {
            await iterator.return?.();
            break;
          }
          if (next instanceof Error) {
            const error = getTRPCErrorFromUnknown(next);
            opts.onError?.({ error, path, type, ctx, req, input });
            respond(client, {
              id,
              jsonrpc,
              error: getErrorShape({
                config: router._def._config,
                error,
                type,
                path,
                input,
                ctx,
              }),
            });
            break;
          }
          if (next.done) {
            break;
          }

          result = {
            type: 'data',
            data: next.value,
          };

          if (isTrackedEnvelope(next.value)) {
            const [id, data] = next.value;
            result.id = id;
            result.data = {
              id,
              data,
            };
          }

          respond(client, {
            id,
            jsonrpc,
            result,
          });

          // free up references for garbage collection
          next = null;
          result = null;
        }

        // need to manually cleanup without using "using"
        // hopefully nothing above throws
        await iterator.return?.();

        respond(client, {
          id,
          jsonrpc,
          result: {
            type: 'stopped',
          },
        });
        clientSubscriptions.delete(id);
      }).catch((cause) => {
        const error = getTRPCErrorFromUnknown(cause);
        opts.onError?.({ error, path, type, ctx, req, input });
        respond(client, {
          id,
          jsonrpc,
          error: getErrorShape({
            config: router._def._config,
            error,
            type,
            path,
            input,
            ctx,
          }),
        });
        abortController.abort();
      });
      clientSubscriptions.set(id, abortController);

      respond(client, {
        id,
        jsonrpc,
        result: {
          type: 'started',
        },
      });
    } catch (cause) /* istanbul ignore next -- @preserve */ {
      // procedure threw an error
      const error = getTRPCErrorFromUnknown(cause);
      opts.onError?.({ error, path, type, ctx, req, input });
      respond(client, {
        id,
        jsonrpc,
        error: getErrorShape({
          config: router._def._config,
          error,
          type,
          path,
          input,
          ctx,
        }),
      });
    }
  }

  return {
    sendPingsAutomatically: opts.uWsBehaviorOptions?.sendPingsAutomatically, // could this be enabled?
    closeOnBackpressureLimit: opts.uWsBehaviorOptions?.closeOnBackpressureLimit,
    compression: opts.uWsBehaviorOptions?.compression,
    maxBackpressure: opts.uWsBehaviorOptions?.maxBackpressure,
    maxPayloadLength: opts.uWsBehaviorOptions?.maxPayloadLength,
    maxLifetime: opts.uWsBehaviorOptions?.maxLifetime,
    idleTimeout: opts.uWsBehaviorOptions?.idleTimeout,
    async upgrade(res, req, context) {
      const resDecorated = decorateHttpResponse(res);
      res.onAborted(() => {
        resDecorated.aborted = true;
      });
      const reqFetch = uWsToRequest(req, resDecorated, {
        maxBodySize: null, // leave it null here?
      });

      const secWebSocketKey = req.getHeader('sec-websocket-key');
      const secWebSocketProtocol = req.getHeader('sec-websocket-protocol');
      const secWebSocketExtensions = req.getHeader('sec-websocket-extensions');

      const clientSubscriptions = new Map<number | string, AbortController>();
      const abortController = new AbortController();

      const data: Decoration = {
        clientSubscriptions,
        abortController,
        req: reqFetch,
        res: resDecorated,
        ctx: undefined,
        ctxPromise: undefined, // major change from the ws implementation
      };

      res.upgrade(
        data,
        secWebSocketKey,
        secWebSocketProtocol,
        secWebSocketExtensions,
        context
      );
    },
    async open(client) {
      allClients.add(client);

      const data = client.getUserData();

      // TODO: cleanup, this is not nice
      data.ctxPromise =
        new URL(data.req.url).searchParams.get('connectionParams') === '1'
          ? unsetContextPromiseSymbol
          : createCtxPromise(client, () => null);

      if (data.ctxPromise !== unsetContextPromiseSymbol) {
        await data.ctxPromise;
      }

      // TODO: handle keepalive is here
      if (opts.keepAlive?.enabled) {
        const { pingMs, pongWaitMs } = opts.keepAlive;
        // handleKeepAlive(client, pingMs, pongWaitMs);
      }
    },
    async message(client, rawMsg) {
      const data = client.getUserData();

      const msgStr = rawMsg.toString(); // or could do this Buffer.from(rawMsg).toString();
      if (msgStr === 'PONG') {
        return;
      }
      if (msgStr === 'PING') {
        if (!opts.dangerouslyDisablePong) {
          client.send('PONG');
        }
        return;
      }

      if (data.ctxPromise === unsetContextPromiseSymbol) {
        // If the ctxPromise wasn't created immediately, we're expecting the first message to be a TRPCConnectionParamsMessage
        data.ctxPromise = createCtxPromise(client, () => {
          let msg;
          try {
            msg = JSON.parse(msgStr) as TRPCConnectionParamsMessage;

            if (!isObject(msg)) {
              throw new Error('Message was not an object');
            }
          } catch (cause) {
            throw new TRPCError({
              code: 'PARSE_ERROR',
              message: `Malformed TRPCConnectionParamsMessage`,
              cause,
            });
          }

          const connectionParams = parseConnectionParamsFromUnknown(msg.data);

          return connectionParams;
        });
        return;
      }

      try {
        const msgJSON: unknown = JSON.parse(msgStr);
        const msgs: unknown[] = Array.isArray(msgJSON) ? msgJSON : [msgJSON];
        const promises = msgs
          .map((raw) => parseTRPCMessage(raw, transformer))
          .map((msg) => {
            return handleRequest(client, msg);
          });
        await Promise.all(promises);
      } catch (cause) {
        const error = new TRPCError({
          code: 'PARSE_ERROR',
          cause,
        });

        respond(client, {
          id: null,
          error: getErrorShape({
            config: router._def._config,
            error,
            type: 'unknown',
            path: undefined,
            input: undefined,
            ctx: undefined,
          }),
        });
      }
    },
    close(client) {
      const { clientSubscriptions, abortController } = client.getUserData();
      for (const sub of clientSubscriptions.values()) {
        sub.abort();
      }
      clientSubscriptions.clear();
      abortController.abort();
      allClients.delete(client);
    },
  };
}

export function applyWSSHandler<TRouter extends AnyRouter>(
  app: TemplatedApp,
  opts: WSSHandlerOptions<TRouter>
) {
  const allClients = new Set<WebSocket<Decoration>>();
  const behavior = getWSConnectionHandler(opts, allClients);

  const prefix = opts.prefix ?? '';

  app.ws(prefix + '/*', behavior);

  // opts.wss.on('connection', (client, req) => {
  //   if (opts.prefix && !req.url?.startsWith(opts.prefix)) {
  //     return;
  //   }

  // TODO: check that these throwing cases arent happening
  // behavior(client, req).catch((cause) => {
  //   opts.onError?.({
  //     error: new TRPCError({
  //       code: 'INTERNAL_SERVER_ERROR',
  //       cause,
  //       message: 'Failed to handle WebSocket connection',
  //     }),
  //     req: req,
  //     path: undefined,
  //     type: 'unknown',
  //     ctx: undefined,
  //     input: undefined,
  //   });

  //   client.close();
  // });
  // });

  return {
    broadcastReconnectNotification: () => {
      const response: TRPCReconnectNotification = {
        id: null,
        method: 'reconnect',
      };
      const data = JSON.stringify(response);
      for (const client of allClients) {
        client.send(data);
      }
    },
  };
}
