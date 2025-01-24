import { getPostBody } from './utils';
import {
  uHTTPRequestHandlerOptions,
  WrappedHTTPRequest,
  WrappedHTTPResponse,
} from './types';
import {
  resolveHTTPResponse,
  type HTTPRequest,
  type ResolveHTTPRequestOptionsContextFn,
} from '@trpc/server/http';

import type { AnyTRPCRouter } from '@trpc/server';

export async function uWsHTTPRequestHandler<
  TRouter extends AnyTRPCRouter,
  TRequest extends WrappedHTTPRequest,
  TResponse extends WrappedHTTPResponse
>(opts: uHTTPRequestHandlerOptions<TRouter, TRequest, TResponse>) {
  const handleViaMiddleware = opts.middleware ?? ((_req, _res, next) => next());
  return handleViaMiddleware(opts.req, opts.res, async (err) => {
    if (err) throw err;

    const createContext: ResolveHTTPRequestOptionsContextFn<TRouter> = async (
      innerOpts
    ) => {
      return opts.createContext?.({
        req: opts.req,
        res: opts.res,
        ...innerOpts,
      });
    };

    // this may not be needed
    const query = new URLSearchParams(opts.req.query);

    const { res, req } = opts;

    if (res.aborted) return;

    const bodyResult = await getPostBody(req.method, res, opts.maxBodySize);

    if (res.aborted) return;

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
          req: opts.req,
        });
      },
    });

    if (res.aborted) return;

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
