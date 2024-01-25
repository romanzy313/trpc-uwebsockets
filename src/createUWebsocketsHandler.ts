import { TemplatedApp, HttpResponse, HttpRequest } from 'uWebSockets.js';
import { applyWSHandler, WSSHandlerOptions } from './applyWsHandler';
import { uWsHTTPRequestHandler } from './requestHandler';
import { uHTTPHandlerOptions, WrappedHTTPRequest } from './types';
import { extractAndWrapHttpRequest } from './utils';

// FIXME depricated
import { AnyRouter } from '@trpc/server';
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
    res.onAborted(() => {
      // console.log('request was aborted');
      res.aborted = true;
    });

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
    applyWSHandler(prefix, opts as WSSHandlerOptions<TRouter>);
  }
}
