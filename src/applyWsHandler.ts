import type { TemplatedApp, WebSocket } from 'uWebSockets.js';

import {
  ProcedureType,
  CombinedDataTransformer,
  AnyRouter,
  inferRouterContext,
  TRPCError,
  callProcedure,
  getTRPCErrorFromUnknown,
  MaybePromise,
} from '@trpc/server';
import { NodeHTTPCreateContextOption } from '@trpc/server/adapters/node-http';
import type { BaseHandlerOptions } from '@trpc/server/src/internals/types';
import { Unsubscribable, isObservable } from '@trpc/server/observable';
import {
  TRPCClientOutgoingMessage,
  TRPCResponseMessage,
  JSONRPC2,
  TRPCReconnectNotification,
} from '@trpc/server/rpc';

// import { transformTRPCResponse } from '../shared/transformTRPCResponse';
import { getErrorShape, transformTRPCResponse } from '@trpc/server/shared';
import { WrappedHTTPRequest } from './types';
import { extractAndWrapHttpRequest } from './utils';

/* istanbul ignore next -- @preserve */
function assertIsObject(obj: unknown): asserts obj is Record<string, unknown> {
  if (typeof obj !== 'object' || Array.isArray(obj) || !obj) {
    throw new Error('Not an object');
  }
}
/* istanbul ignore next -- @preserve */
function assertIsProcedureType(obj: unknown): asserts obj is ProcedureType {
  if (obj !== 'query' && obj !== 'subscription' && obj !== 'mutation') {
    throw new Error('Invalid procedure type');
  }
}
/* istanbul ignore next -- @preserve */
function assertIsRequestId(
  obj: unknown
): asserts obj is number | string | null {
  if (
    obj !== null &&
    typeof obj === 'number' &&
    isNaN(obj) &&
    typeof obj !== 'string'
  ) {
    throw new Error('Invalid request id');
  }
}
/* istanbul ignore next -- @preserve */
function assertIsString(obj: unknown): asserts obj is string {
  if (typeof obj !== 'string') {
    throw new Error('Invalid string');
  }
}
/* istanbul ignore next -- @preserve */
function assertIsJSONRPC2OrUndefined(
  obj: unknown
): asserts obj is '2.0' | undefined {
  if (typeof obj !== 'undefined' && obj !== '2.0') {
    throw new Error('Must be JSONRPC 2.0');
  }
}
function parseMessage(
  obj: unknown,
  transformer: CombinedDataTransformer
): TRPCClientOutgoingMessage {
  assertIsObject(obj);
  const { method, params, id, jsonrpc } = obj;
  assertIsRequestId(id);
  assertIsJSONRPC2OrUndefined(jsonrpc);
  if (method === 'subscription.stop') {
    return {
      id,
      jsonrpc,
      method,
    };
  }
  assertIsProcedureType(method);
  assertIsObject(params);

  const { input: rawInput, path } = params;
  assertIsString(path);
  const input = transformer.input.deserialize(rawInput);
  return {
    id,
    jsonrpc,
    method,
    params: {
      input,
      path,
    },
  };
}

/**
 * Web socket server handler
 */
export type WSSHandlerOptions<TRouter extends AnyRouter> = BaseHandlerOptions<
  TRouter,
  WrappedHTTPRequest
  //   IncomingMessage
> &
  NodeHTTPCreateContextOption<TRouter, WrappedHTTPRequest, any>;

// export type CreateWSSContextFnOptions = NodeHTTPCreateContextFnOptions<
//   IncomingMessage,
//   ws
// >;

type Decoration = {
  clientSubscriptions: Map<number | string, Unsubscribable>;
  ctxPromise: MaybePromise<inferRouterContext<AnyRouter>> | undefined;
  ctx: inferRouterContext<AnyRouter> | undefined;
  req: WrappedHTTPRequest;
};

type DecoratedWebSocket = WebSocket & Decoration;

export function applyWSHandler<TRouter extends AnyRouter>(
  app: TemplatedApp,
  prefix: string,
  opts: WSSHandlerOptions<TRouter>
) {
  const { createContext, router } = opts;

  const { transformer } = router._def._config;

  // global map of maps

  //   const globalSubs = new Map<WebSocket, Map<number | string, Unsubscribable>>();
  //   const globals = new Map<WebSocket, Decoration>();

  function respond(ws: WebSocket, untransformedJSON: TRPCResponseMessage) {
    ws.send(
      JSON.stringify(
        transformTRPCResponse(router._def._config, untransformedJSON)
      )
    );
  }

  function stopSubscription(
    ws: WebSocket,
    subscription: Unsubscribable,
    { id, jsonrpc }: JSONRPC2.BaseEnvelope & { id: JSONRPC2.RequestId }
  ) {
    subscription.unsubscribe();

    respond(ws, {
      id,
      jsonrpc,
      result: {
        type: 'stopped',
      },
    });
  }

  async function handleRequest(
    ws: DecoratedWebSocket,
    msg: TRPCClientOutgoingMessage
  ) {
    const clientSubscriptions = ws.clientSubscriptions;

    const { id, jsonrpc } = msg;
    /* istanbul ignore next -- @preserve */
    if (id === null) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: '`id` is required',
      });
    }
    if (msg.method === 'subscription.stop') {
      const sub = clientSubscriptions.get(id);
      if (sub) {
        stopSubscription(ws, sub, { id, jsonrpc });
      }
      clientSubscriptions.delete(id);
      return;
    }
    const { path, input } = msg.params;
    const type = msg.method;
    try {
      await ws.ctxPromise; // asserts context has been set

      const result = await callProcedure({
        procedures: router._def.procedures,
        path,
        rawInput: input,
        ctx: ws.ctx,
        type,
      });

      if (type === 'subscription') {
        if (!isObservable(result)) {
          throw new TRPCError({
            message: `Subscription ${path} did not return an observable`,
            code: 'INTERNAL_SERVER_ERROR',
          });
        }
      } else {
        // send the value as data if the method is not a subscription
        respond(ws, {
          id,
          jsonrpc,
          result: {
            type: 'data',
            data: result,
          },
        });
        return;
      }

      const observable = result;
      const sub = observable.subscribe({
        next(data) {
          respond(ws, {
            id,
            jsonrpc,
            result: {
              type: 'data',
              data,
            },
          });
        },
        error(err) {
          const error = getTRPCErrorFromUnknown(err);
          opts.onError?.({
            error,
            path,
            type,
            ctx: ws.ctx,
            req: ws.req,
            input,
          });
          respond(ws, {
            id,
            jsonrpc,
            error: getErrorShape({
              config: router._def._config,
              error,
              type,
              path,
              input,
              ctx: ws.ctx,
            }),
          });
        },
        complete() {
          respond(ws, {
            id,
            jsonrpc,
            result: {
              type: 'stopped',
            },
          });
        },
      });
      /* istanbul ignore next -- @preserve */
      // FIXME handle these edge cases
      //   if (client.readyState !== client.OPEN) {
      //     // if the client got disconnected whilst initializing the subscription
      //     // no need to send stopped message if the client is disconnected
      //     sub.unsubscribe();
      //     return;
      //   }

      /* istanbul ignore next -- @preserve */
      if (clientSubscriptions.has(id)) {
        // duplicate request ids for client
        stopSubscription(ws, sub, { id, jsonrpc });
        throw new TRPCError({
          message: `Duplicate id ${id}`,
          code: 'BAD_REQUEST',
        });
      }
      clientSubscriptions.set(id, sub);

      respond(ws, {
        id,
        jsonrpc,
        result: {
          type: 'started',
        },
      });
    } catch (cause) /* istanbul ignore next -- @preserve */ {
      // procedure threw an error
      const error = getTRPCErrorFromUnknown(cause);
      opts.onError?.({ error, path, type, ctx: ws.ctx, req: ws.req, input });
      respond(ws, {
        id,
        jsonrpc,
        error: getErrorShape({
          config: router._def._config,
          error,
          type,
          path,
          input,
          ctx: ws.ctx,
        }),
      });
    }
  }

  // this is probably bad, but its for reconnection notification
  const allClients = new Set<DecoratedWebSocket>();

  app.ws(prefix, {
    // sendPingsAutomatically: true, // could this be enabled?

    upgrade: (res, ogReq, context) => {
      // console.log(
      //   'An Http connection wants to become WebSocket, URL: ' +
      //     ogReq.getUrl() +
      //     '!'
      // );

      const wrappedReq = extractAndWrapHttpRequest(prefix, ogReq);

      const secWebSocketKey = wrappedReq.headers['sec-websocket-key'];
      const secWebSocketProtocol = wrappedReq.headers['sec-websocket-protocol'];
      const secWebSocketExtensions =
        wrappedReq.headers['sec-websocket-extensions'];

      const d: Decoration = {
        clientSubscriptions: new Map<number | string, Unsubscribable>(),
        ctx: undefined,
        req: wrappedReq,
        ctxPromise: createContext?.({ req: wrappedReq, res }), // this cannot use RES!
      };

      res.upgrade(
        d,
        /* Spell these correctly */
        secWebSocketKey,
        secWebSocketProtocol,
        secWebSocketExtensions,
        context
      );
    },
    // @ts-expect-error Adds decoration on ws type
    async open(ws: DecoratedWebSocket) {
      async function createContextAsync() {
        try {
          ws.ctx = await ws.ctxPromise;
        } catch (cause) {
          const error = getTRPCErrorFromUnknown(cause);
          opts.onError?.({
            error,
            path: undefined,
            type: 'unknown',
            ctx: ws.ctx,
            req: ws.req,
            input: undefined,
          });
          respond(ws, {
            id: null,
            error: getErrorShape({
              config: router._def._config,
              error,
              type: 'unknown',
              path: undefined,
              input: undefined,
              ctx: ws.ctx,
            }),
          });

          // close in next tick
          // FIXME check if this is okay?
          (global.setImmediate ?? global.setTimeout)(() => {
            ws.close();
          });
        }
      }
      await createContextAsync();
      allClients.add(ws);
    },

    // @ts-expect-error Adds decoration on ws type
    async message(ws: DecoratedWebSocket, rawMsg) {
      try {
        const stringMsg = Buffer.from(rawMsg).toString();

        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const msgJSON: unknown = JSON.parse(stringMsg);
        // TODO pre-optimization? why does it always sends empty arrays?
        // if (Array.isArray(msgJSON) && msgJSON.length == 0)
        //   return;

        const msgs: unknown[] = Array.isArray(msgJSON) ? msgJSON : [msgJSON];
        const promises = msgs
          .map((raw) => parseMessage(raw, transformer))
          .map((value) => handleRequest(ws, value));

        await Promise.all(promises);
      } catch (cause) {
        const error = new TRPCError({
          code: 'PARSE_ERROR',
          cause,
        });

        respond(ws, {
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

    // @ts-expect-error Adds decoration on ws type
    close(ws: DecoratedWebSocket) {
      for (const sub of ws.clientSubscriptions.values()) {
        sub.unsubscribe();
      }
      ws.clientSubscriptions.clear();
      allClients.delete(ws);
    },
  });

  return {
    broadcastReconnectNotification: () => {
      const response: TRPCReconnectNotification = {
        id: null,
        method: 'reconnect',
      };
      const data = JSON.stringify(response);
      allClients.forEach((v) => {
        v.send(data);
      });
      // for (const client of wss.clients) {
      //   if (client.readyState === 1 /* ws.OPEN */) {
      //     client.send(data);
      //   }
      // }
    },
  };
}
