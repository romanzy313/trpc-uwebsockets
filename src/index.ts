import { AnyRouter } from '@trpc/server';
import { uWsHTTPRequestHandler } from './requestHandler';
import { extractAndWrapHttpRequest } from './utils';
import { applyWSHandler, WSSHandlerOptions } from './applyWsHandler';
import type { uHTTPHandlerOptions, WrappedHTTPRequest } from './types';
import type { HttpRequest, HttpResponse, TemplatedApp } from 'uWebSockets.js';

export * from './types';
export * from './applyWsHandler';

/**
 * @param uWsApp uWebsockets server instance
 * @param prefix The path to trpc without trailing slash (ex: "/trpc")
 * @param opts handler options
 */
export function createUWebSocketsHandler<TRouter extends AnyRouter>(
  uWsApp: TemplatedApp,
  prefix: string,
  opts: uHTTPHandlerOptions<TRouter, WrappedHTTPRequest, HttpResponse>
) {
  const handler = (res: HttpResponse, req: HttpRequest) => {
    const wrappedReq = extractAndWrapHttpRequest(prefix, req);

    uWsHTTPRequestHandler({
      req: wrappedReq,
      res: res,
      path: wrappedReq.url,
      ...opts,
    });
  };
  uWsApp.get(prefix + '/*', handler);
  uWsApp.post(prefix + '/*', handler);

  if (opts.enableSubscriptions) {
    opts.router;
    applyWSHandler(uWsApp, prefix, opts as WSSHandlerOptions<TRouter>);
  }
}
