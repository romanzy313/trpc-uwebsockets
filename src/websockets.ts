import {
  type AnyRouter,
  type CreateContextCallback,
  callTRPCProcedure,
  getErrorShape,
  getTRPCErrorFromUnknown,
  inferRouterContext,
  isTrackedEnvelope,
  transformTRPCResponse,
  TRPCError,
} from '@trpc/server';
import { NodeHTTPCreateContextFnOptions } from '@trpc/server/adapters/node-http';
import {
  type BaseHandlerOptions,
  type TRPCRequestInfo,
  parseConnectionParamsFromUnknown,
} from '@trpc/server/http';
import {
  isObservable,
  observableToAsyncIterable,
} from '@trpc/server/observable';
import {
  type TRPCClientOutgoingMessage,
  type TRPCConnectionParamsMessage,
  type TRPCReconnectNotification,
  type TRPCResponseMessage,
  type TRPCResultMessage,
  parseTRPCMessage,
} from '@trpc/server/rpc';
import {
  type MaybePromise,
  isAsyncIterable,
  isObject,
  iteratorResource,
  run,
  Unpromise,
} from '@trpc/server/unstable-core-do-not-import';
import { URL } from 'url';
import type {
  TemplatedApp,
  WebSocket,
  WebSocketBehavior,
} from 'uWebSockets.js';

import {
  createURL,
  decorateHttpResponse,
  HttpResponseDecorated,
  uWsToRequestNoBody,
} from './fetchCompat';

type RemoveFunctions<T> = {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  [K in keyof T as NonNullable<T[K]> extends Function ? never : K]: T[K];
};
/**
 * A structure holding settings for a WebSocket handler.
 */
export type WebSocketBehaviorOptions = RemoveFunctions<WebSocketBehavior<any>>;

export type WebSocketConnection = WebSocket<WebsocketData>;

// following packages/server/src/adapters/ws.ts

/**
 * @public
 */
export type CreateWSSContextFnOptions = NodeHTTPCreateContextFnOptions<
  Request,
  HttpResponseDecorated
  // WebSocketConnection
> & {
  client: WebSocketConnection;
};

export type CreateWSSContextFn<TRouter extends AnyRouter> = (
  opts: CreateWSSContextFnOptions
) => MaybePromise<inferRouterContext<TRouter>>;

export type WSConnectionHandlerOptions<TRouter extends AnyRouter> =
  BaseHandlerOptions<TRouter, Request> &
    CreateContextCallback<
      inferRouterContext<TRouter>,
      CreateWSSContextFn<TRouter>
    >;

export type WebsocketsKeepAlive = {
  /**
   * Enable heartbeat messages
   * @default false
   */
  enabled: boolean;
  /**
   * Heartbeat interval in milliseconds
   * @default 30_000
   */
  pingMs?: number | undefined;
  /**
   * Terminate the WebSocket if no pong is received after this many milliseconds
   * @default 5_000
   */
  pongWaitMs?: number | undefined;
};

/**
 * WebSockets handler definition
 */
export type WebsocketsHandlerOptions<TRouter extends AnyRouter> =
  WSConnectionHandlerOptions<TRouter> & {
    /**
     * Url path prefix where the tRPC server will be registered.
     * @default ''
     */
    prefix?: string | undefined;
    /**
     * Specify if SSL is used. Set to true if you are using SSLApp or if the server is served behind SSL reverse proxy.
     * @default false
     */
    ssl?: boolean | undefined;
    keepAlive?: WebsocketsKeepAlive | undefined;
    /**
     * Disable responding to ping messages from the client
     * **Not recommended** - this is mainly used for testing
     * @default false
     */
    dangerouslyDisablePong?: boolean | undefined;
    /**
     * uWebSockets.js WebSocket hander settings
     */
    uWsBehaviorOptions?: WebSocketBehaviorOptions | undefined;
  };

interface Completer {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function createCompleter(): Completer {
  let resolve: () => void;
  let reject: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve: resolve!,
    reject: reject!,
  };
}

// data bound internally on each client
type WebsocketData = {
  req: Request;
  clientSubscriptions: Map<number | string, AbortController>;
  abortController: AbortController;
  ctx: inferRouterContext<AnyRouter> | undefined;
  /**
   * inside-out promise that resolves when context is ready.
   *
   * - when this is null, the context resolution will be started
   * - otherwise all requests must await context resolution
   */
  ctxCompleter: Completer | null;
  keepAlive: KeepAliver | null;
  url: URL;
};

export function getWSConnectionHandler<TRouter extends AnyRouter>(
  opts: WebsocketsHandlerOptions<TRouter>,
  allClients: Set<WebSocketConnection>
): WebSocketBehavior<WebsocketData> {
  const { createContext, router } = opts;
  const { transformer } = router._def._config;

  function respond(
    client: WebSocketConnection,
    untransformedJSON: TRPCResponseMessage
  ) {
    try {
      client.send(
        JSON.stringify(
          transformTRPCResponse(router._def._config, untransformedJSON)
        )
      );
    } catch {
      // client.send can throw if connection is already closed.
      // happens when client forcefully terminates the connection
      // and server is sending keepalive messages
    }
  }

  function getConnectionParams(
    msgStr: string
  ): TRPCRequestInfo['connectionParams'] {
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
  }

  async function handleRequest(
    client: WebSocket<WebsocketData>,
    msg: TRPCClientOutgoingMessage
  ) {
    const { clientSubscriptions, ctx, req } = client.getUserData();

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

      if (ctx === null) {
        throw new Error('assertion: context should never be null');
      }

      const abortController = new AbortController();
      const result = await callTRPCProcedure({
        router,
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
        await using iterator = iteratorResource(iterable);

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
          next = await Unpromise.race([
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
    upgrade(res, req, context) {
      const resDecorated = decorateHttpResponse(res);

      res.onAborted(() => {
        resDecorated.aborted = true;
      });
      const reqFetch = uWsToRequestNoBody(req, resDecorated);

      const secWebSocketKey = req.getHeader('sec-websocket-key');
      const secWebSocketProtocol = req.getHeader('sec-websocket-protocol');
      const secWebSocketExtensions = req.getHeader('sec-websocket-extensions');

      const clientSubscriptions = new Map<number | string, AbortController>();
      const abortController = new AbortController();

      const data: WebsocketData = {
        clientSubscriptions,
        abortController,
        req: reqFetch,
        ctx: undefined,
        ctxCompleter: null,
        keepAlive: null,
        url: createURL(req, resDecorated.sll ? 'wss' : 'ws'),
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

      if (opts.keepAlive?.enabled) {
        const { pingMs, pongWaitMs } = opts.keepAlive;
        const data = client.getUserData();
        data.keepAlive = handleKeepAlive(client, pingMs, pongWaitMs);
      }
    },
    async message(client, rawMsg) {
      const data = client.getUserData();

      if (data.keepAlive) {
        data.keepAlive.onMessage();
      }

      const msgStr = Buffer.from(rawMsg).toString();

      if (msgStr === 'PONG') {
        return;
      }
      if (msgStr === 'PING') {
        if (!opts.dangerouslyDisablePong) {
          client.send('PONG');
        }
        return;
      }

      if (data.ctxCompleter == null) {
        data.ctxCompleter = createCompleter();

        const useConnectionParams =
          data.url.searchParams.get('connectionParams') === '1';

        try {
          data.ctx = await createContext?.({
            req: data.req,
            res: client as unknown as HttpResponseDecorated,
            client: client,
            info: {
              connectionParams: useConnectionParams
                ? getConnectionParams(msgStr)
                : null,
              calls: [],
              isBatchCall: false,
              accept: null,
              type: 'unknown',
              signal: data.abortController.signal,
              url: data.url,
            },
          });
          data.ctxCompleter.resolve();
        } catch (cause) {
          const error = getTRPCErrorFromUnknown(cause);
          opts.onError?.({
            ctx: data.ctx,
            error: error,
            input: undefined,
            path: undefined,
            type: 'unknown',
            req: data.req,
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
          data.ctxCompleter.reject(error);

          // close in next tick
          (globalThis.setImmediate ?? globalThis.setTimeout)(() => {
            client.end(1008);
          });
        }

        if (useConnectionParams) {
          // fully consume first message
          return;
        }
      }

      try {
        await data.ctxCompleter.promise;
      } catch {
        // stop execution of pending requests when context could not be resolved
        // single error message will be sent
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
      const { clientSubscriptions, abortController, keepAlive } =
        client.getUserData();

      if (keepAlive) {
        keepAlive.onClose();
      }

      for (const sub of clientSubscriptions.values()) {
        sub.abort();
      }
      clientSubscriptions.clear();
      abortController.abort();
      allClients.delete(client);
    },
  };
}

export function applyWebsocketHandler<TRouter extends AnyRouter>(
  app: TemplatedApp,
  opts: WebsocketsHandlerOptions<TRouter>
) {
  const allClients = new Set<WebSocket<WebsocketData>>();
  const behavior = getWSConnectionHandler(opts, allClients);

  const prefix = opts.prefix ?? '';

  app.ws(prefix, behavior);

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

type KeepAliver = {
  onMessage: () => void;
  onClose: () => void;
};

export function handleKeepAlive(
  client: WebSocketConnection,
  pingMs = 30_000,
  pongWaitMs = 5_000
): KeepAliver {
  let timeout: NodeJS.Timeout | undefined = undefined;
  let ping: NodeJS.Timeout | undefined = undefined;

  const schedulePing = () => {
    const scheduleTimeout = () => {
      timeout = setTimeout(() => {
        client.close();
      }, pongWaitMs);
    };
    ping = setTimeout(() => {
      client.send('PING');

      scheduleTimeout();
    }, pingMs);
  };

  schedulePing();

  return {
    onMessage() {
      clearTimeout(ping);
      clearTimeout(timeout);

      schedulePing();
    },
    onClose() {
      clearTimeout(ping);
      clearTimeout(timeout);
    },
  };
}
