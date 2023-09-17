/* eslint-disable @typescript-eslint/no-explicit-any */
import { AnyRouter } from '@trpc/server';
import type { HttpRequest, HttpResponse, TemplatedApp } from 'uWebSockets.js';
import { uWsHTTPRequestHandler } from './requestHandler';

import { uHTTPHandlerOptions, WrappedHTTPRequest } from './types';
import { extractAndWrapHttpRequest } from './utils';
import { applyWSHandler } from './applyWsHandler';

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
  // opts: uHTTPHandlerOptions<TRouter, TRequest, TResponse>
) {
  // const prefixTrimLength = prefix.length + 1; // remove /* from url

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
    // do something

    applyWSHandler(uWsApp, prefix, opts);

    // uWsApp.ws(prefix + '/*', behavior)
  }
}
