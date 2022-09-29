/* eslint-disable @typescript-eslint/no-explicit-any */
import { AnyRouter } from '@trpc/server';
// import { HTTPRequest } from '@trpc/server/dist/index';
import type { HttpRequest, HttpResponse, TemplatedApp } from 'uWebSockets.js';
import { uWsHTTPRequestHandler } from './requestHandler';

import {
  uHTTPHandlerOptions,
  WrappedHTTPRequest,
  WrappedHTTPResponse,
} from './types';

// export * from './types';

/**
 * @param uWsApp uWebsockets server instance
 * @param prefix The path to trpc without trailing slash (ex: "/trpc")
 * @param opts handler options
 */
export function createUWebSocketsHandler<TRouter extends AnyRouter>(
  uWsApp: TemplatedApp,
  prefix: string,
  opts: uHTTPHandlerOptions<TRouter>
) {
  const prefixTrimLength = prefix.length + 1; // remove /* from url

  const handler = (res: HttpResponse, req: HttpRequest) => {
    const method = req.getMethod().toUpperCase() as 'GET' | 'POST';
    const url = req.getUrl().substring(prefixTrimLength);
    const query = req.getQuery();

    const headers: Record<string, string> = {};
    req.forEach((key, value) => {
      // TODO handle headers with the same key, potential issue
      headers[key] = value;
    });

    // new request object needs to be created, because socket
    // can only be accessed synchronously, after await it cannot be accessed
    const wrappedReq: WrappedHTTPRequest = {
      headers,
      method,
      query,
      url,
    };

    uWsHTTPRequestHandler({
      req: wrappedReq,
      uRes: res,
      path: url,
      ...opts,
    });
  };
  uWsApp.get(prefix + '/*', handler);
  uWsApp.post(prefix + '/*', handler);
}
