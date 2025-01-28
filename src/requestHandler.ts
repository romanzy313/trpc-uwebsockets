import type { TemplatedApp, HttpRequest, HttpResponse } from 'uWebSockets.js';

import {
  // type NodeHTTPCreateContextFnOption,
  type NodeHTTPCreateContextFnOptions,
} from '@trpc/server/adapters/node-http';
import type { AnyRouter } from '@trpc/server';
import {
  resolveResponse,
  type HTTPBaseHandlerOptions,
  type ResolveHTTPRequestOptionsContextFn,
} from '@trpc/server/http';
// @trpc/server/node-http
import {
  type NodeHTTPCreateContextOption,
  // type NodeHTTPCreateContextFnOptions,
} from '@trpc/server/adapters/node-http';

// import { applyWebsocketsHandler, WebsocketsHandlerOptions } from './websockets';
import {
  decorateHttpResponse,
  HttpResponseDecorated,
  uWsSendResponseStreamed,
  uWsToRequest,
} from './fetchCompat';

export interface CreateUwsHandlerOptions<TRouter extends AnyRouter> {
  prefix?: string;
  // middleware?: ConnectMiddleware; // TODO, or not needed?
  trpcOptions: UWsHandlerOptions<TRouter, Request, HttpResponseDecorated>;
  maxBodySize?: number;
}

export type CreateUWsContextOptions = NodeHTTPCreateContextFnOptions<
  Request,
  HttpResponseDecorated
>;

export function createUWebSocketsHandler<TRouter extends AnyRouter>(
  app: TemplatedApp,
  opts: CreateUwsHandlerOptions<TRouter>
) {
  const prefix = opts.prefix ?? '';

  const handler = async (res: HttpResponse, req: HttpRequest) => {
    const url = req.getUrl().substring(prefix.length + 1);
    const resDecorated = decorateHttpResponse(res);
    const reqFetch = uWsToRequest(req, resDecorated, {
      maxBodySize: opts.maxBodySize ?? null,
    });

    await uWsRequestHandler({
      ...opts.trpcOptions,
      req: reqFetch,
      res: resDecorated,
      path: url,
    });
  };

  app.get(prefix + '/*', handler);
  app.post(prefix + '/*', handler);

  // if (opts.useWebsockets) {
  //   throw new Error('TODO');
  //   const trpcOptions =
  //     opts.trpcOptions as unknown as WSSHandlerOptions<AnyRouter>;
  //   // opts.trpcOptions as unknown as WSSHandlerOptions<TRouter>;
  //   applyWSSHandler({
  //     ...trpcOptions,
  //   });
  // }

  // if (opts.useWSS) {
  //   const trpcOptions =
  //     opts.trpcOptions as unknown as WSSHandlerOptions<TRouter>;

  //   const onConnection = getWSConnectionHandler<TRouter>({
  //     ...trpcOptions,
  //   });

  //   fastify.get(prefix ?? '/', { websocket: true }, async (socket, req) => {
  //     await onConnection(socket, req.raw);
  //     if (trpcOptions?.keepAlive?.enabled) {
  //       const { pingMs, pongWaitMs } = trpcOptions.keepAlive;
  //       handleKeepAlive(socket, pingMs, pongWaitMs);
  //     }
  //   });
  // }
}

export type UWsHandlerOptions<
  TRouter extends AnyRouter,
  TRequest extends Request,
  TResponse extends HttpResponseDecorated,
> = HTTPBaseHandlerOptions<TRouter, TRequest> &
  NodeHTTPCreateContextOption<TRouter, TRequest, TResponse>;

type UWsRequestHandlerOptions<
  TRouter extends AnyRouter,
  TRequest extends Request,
  TResponse extends HttpResponseDecorated,
> = UWsHandlerOptions<TRouter, TRequest, TResponse> & {
  req: TRequest;
  res: TResponse;
  path: string;
  // maxBodySize?: number;
};

export async function uWsRequestHandler<
  TRouter extends AnyRouter,
  TRequest extends Request,
  TResponse extends HttpResponseDecorated,
>(opts: UWsRequestHandlerOptions<TRouter, TRequest, TResponse>) {
  const createContext: ResolveHTTPRequestOptionsContextFn<TRouter> = async (
    innerOpts
  ) => {
    return await opts.createContext?.({
      ...opts,
      ...innerOpts,
    });
  };

  // const fetchReq = uWsToRequest(opts.req, resDecorated, {
  //   maxBodySize: opts.maxBodySize ?? null,
  // });

  const fetchRes = await resolveResponse({
    ...opts,
    req: opts.req, // niew
    error: null,
    createContext,
    onError(o) {
      opts?.onError?.({
        ...o,
        req: opts.req,
      });
    },
  });

  await uWsSendResponseStreamed(fetchRes, opts.res);
}
