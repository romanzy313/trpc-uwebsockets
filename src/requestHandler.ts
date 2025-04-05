import type { HttpRequest, HttpResponse, TemplatedApp } from 'uWebSockets.js';
import type { AnyRouter } from '@trpc/server';
import {
  type NodeHTTPCreateContextFnOptions,
  type NodeHTTPCreateContextOption,
} from '@trpc/server/adapters/node-http';
import {
  resolveResponse,
  type HTTPBaseHandlerOptions,
  type ResolveHTTPRequestOptionsContextFn,
} from '@trpc/server/http';

import {
  decorateHttpResponse,
  HttpResponseDecorated,
  uWsSendResponseStreamed,
  uWsToRequest,
} from './fetchCompat';
import { WebSocketConnection } from './websockets';

export interface CreateHandlerOptions<TRouter extends AnyRouter> {
  /**
   * Url path prefix where the tRPC server will be registered.
   * @default ''
   */
  prefix?: string | undefined;
  /**
   * Specify if SSL is used. Set to true if your application is served over HTTPS.
   * @default false
   */
  ssl?: boolean | undefined;
  /**
   * Maximum request body size in bytes. If the body is larger than this, the request will be aborted.
   * Null value allows for unlimited body size.
   * @default null
   */
  maxBodySize?: number | undefined;
  trpcOptions: HandlerOptions<TRouter, Request, HttpResponseDecorated>;
}

export type CreateContextOptions = NodeHTTPCreateContextFnOptions<
  Request,
  HttpResponseDecorated
> & {
  /**
   * Client must be passed along when the context is created.
   **/
  client?: WebSocketConnection | undefined;
};

/**
 * Applies tRPC request handler to uWebSockets app.
 * @param app - The uWebSockets application.
 * @param opts - Options for configuring the tRPC request handler.
 */
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

  const fetchRes = await resolveResponse({
    ...opts,
    req: opts.req,
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
