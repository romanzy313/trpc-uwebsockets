import { AnyRouter, inferRouterContext } from '@trpc/server';
import { getPostBody } from './utils';
import {
  uHTTPRequestHandlerOptions,
  WrappedHTTPRequest,
  WrappedHTTPResponse,
} from './types';
import type { HTTPRequest } from '@trpc/server/src/http/types';
import { resolveHTTPResponse } from '@trpc/server/http';

export async function uWsHTTPRequestHandler<
  TRouter extends AnyRouter,
  TRequest extends WrappedHTTPRequest,
  TResponse extends WrappedHTTPResponse
>(opts: uHTTPRequestHandlerOptions<TRouter, TRequest, TResponse>) {
  const handleViaMiddleware = opts.middleware ?? ((_req, _res, next) => next());

  return handleViaMiddleware(opts.req, opts.res, async (err) => {
    if (err) throw err;

    const createContext = async (): Promise<inferRouterContext<TRouter>> => {
      return await opts.createContext?.(opts as any); // TODO type this up
    };

    // this may not be needed
    const query = new URLSearchParams(opts.req.query);

    const { res, req } = opts;
    let aborted = false;
    res.onAborted(() => {
      // console.log('request was aborted');
      aborted = true;
    });

    const bodyResult = await getPostBody(req.method, res, opts.maxBodySize);

    const reqObj: HTTPRequest = {
      method: opts.req.method!,
      headers: opts.req.headers,
      query,
      body: bodyResult.ok ? bodyResult.data : undefined,
    };

    const result = await resolveHTTPResponse({
      batching: opts.batching,
      responseMeta: opts.responseMeta,
      path: opts.path,
      createContext,
      router: opts.router,
      req: reqObj,
      error: bodyResult.ok ? null : bodyResult.error,
      preprocessedBody: false,
      onError(o) {
        opts?.onError?.({
          ...o,
          req: opts.req as any,
        });
      },
    });

    if (aborted) {
      return;
    }

    res.cork(() => {
      res.writeStatus(result.status.toString()); // is this okay?

      // oldschool way of writing headers
      for (const [key, value] of Object.entries(result.headers ?? {})) {
        if (typeof value === 'undefined') {
          continue;
        }
        if (Array.isArray(value))
          value.forEach((v) => {
            res.writeHeader(key, v);
          });
        else res.writeHeader(key, value);
      }

      res.end(result.body);
    });
  });
}
