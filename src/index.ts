import { AnyRouter } from '@trpc/server';
import { uWsHTTPRequestHandler } from './requestHandler';

import {
  uHTTPHandlerOptions,
  WrappedHTTPRequest,
  WrappedHTTPResponse,
} from './types';
import { extractAndWrapHttpRequest } from './utils';
import { applyWSHandler, WSSHandlerOptions } from './applyWsHandler';
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
  opts: uHTTPHandlerOptions<TRouter, WrappedHTTPRequest, WrappedHTTPResponse>
  // opts: uHTTPHandlerOptions<TRouter, TRequest, TResponse>
) {
  // const prefixTrimLength = prefix.length + 1; // remove /* from url

  const cors = (res: HttpResponse) => {
    if (!opts.cors) {
      return;
    }
    const c = opts.cors;
    const allowOrigin =
      c === true || !c.origin
        ? '*'
        : Array.isArray(c.origin)
        ? c.origin.join(',')
        : c.origin;
    const allowHeaders =
      c === true || !c.headers
        ? 'origin, content-type, accept, authorization'
        : c.headers.join(', ');
    res.cork(() => {
      res
        .writeHeader('Access-Control-Allow-Origin', allowOrigin)
        .writeHeader(
          'Access-Control-Allow-Methods',
          'GET, POST, PUT, DELETE, OPTIONS'
        )
        .writeHeader('Access-Control-Allow-Headers', allowHeaders)
        .writeHeader('Access-Control-Allow-Credentials', 'true')
        .writeHeader('Access-Control-Max-Age', '3600');
    });
  };

  const handler = (res: HttpResponse, req: HttpRequest) => {
    if (opts.cors) {
      cors(res);
    }
    const wrappedReq = extractAndWrapHttpRequest(prefix, req);

    uWsHTTPRequestHandler({
      req: wrappedReq,
      res: res,
      path: wrappedReq.url,
      ...opts,
    });
  };
  if (opts.cors) {
    uWsApp.options(prefix + '/*', (res) => {
      cors(res);
      res.end();
    });
  }
  uWsApp.get(prefix + '/*', handler);
  uWsApp.post(prefix + '/*', handler);

  if (opts.enableSubscriptions) {
    opts.router;
    applyWSHandler(uWsApp, prefix, opts as WSSHandlerOptions<TRouter>);
  }
}
