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
import { WebSocketConnection } from './websockets';

export interface CreateHandlerOptions<TRouter extends AnyRouter> {
  prefix?: string;
  /**
    specify if SSL is used (SSLApp instead of App)

    @default false
  **/
  ssl?: boolean;
  trpcOptions: HandlerOptions<TRouter, Request, HttpResponseDecorated>;
  maxBodySize?: number;
}

export type CreateContextOptions = NodeHTTPCreateContextFnOptions<
  Request,
  HttpResponseDecorated
> & {
  /*
    optional client which must be set when context is created for websockets
  */
  client?: WebSocketConnection;
};

export function applyRequestHandler<TRouter extends AnyRouter>(
  app: TemplatedApp,
  opts: CreateHandlerOptions<TRouter>
) {
  const prefix = opts.prefix ?? '';

  const handler = async (res: HttpResponse, req: HttpRequest) => {
    const url = req.getUrl().substring(prefix.length + 1);
    const resDecorated = decorateHttpResponse(res, opts.ssl);
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
}

export type HandlerOptions<
  TRouter extends AnyRouter,
  TRequest extends Request,
  TResponse extends HttpResponseDecorated,
> = HTTPBaseHandlerOptions<TRouter, TRequest> &
  NodeHTTPCreateContextOption<TRouter, TRequest, TResponse>;

type RequestHandlerOptions<
  TRouter extends AnyRouter,
  TRequest extends Request,
  TResponse extends HttpResponseDecorated,
> = HandlerOptions<TRouter, TRequest, TResponse> & {
  req: TRequest;
  res: TResponse;
  path: string;
  // maxBodySize?: number;
};

export async function uWsRequestHandler<
  TRouter extends AnyRouter,
  TRequest extends Request,
  TResponse extends HttpResponseDecorated,
>(opts: RequestHandlerOptions<TRouter, TRequest, TResponse>) {
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
