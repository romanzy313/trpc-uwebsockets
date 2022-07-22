import {
  AnyRouter,
  inferRouterContext,
  resolveHTTPResponse,
} from '@trpc/server';
import { HTTPRequest } from '@trpc/server/dist/declarations/src/http/internals/types';
import { CookieParseOptions, CookieSerializeOptions } from 'cookie';
import type {
  HttpRequest,
  HttpResponse,
  RecognizedString,
  TemplatedApp,
} from 'uWebSockets.js';
import {
  UWebSocketsRegisterEndpointOptions as UWebSocketsCreateHandlerOptions,
  UWebSocketsRequestObject,
  UWebSocketsResponseObject,
} from './types';
import { getCookieFn, readPostBody } from './utils';
import cookie from 'cookie';
export * from './types';

/**
 *
 * @param uWsApp uWebsockets server instance
 * @param pathPrefix The path to endpoint without trailing slash (ex: "/trpc")
 * @param opts router and createContext options
 */
export function createUWebSocketsHandler<TRouter extends AnyRouter>(
  uWsApp: TemplatedApp,
  pathPrefix: string,
  opts: UWebSocketsCreateHandlerOptions<TRouter>
) {
  const prefixTrimLength = pathPrefix.length + 1; // remove /* from url

  const handler = async (res: HttpResponse, req: HttpRequest) => {
    const method = req.getMethod().toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      // handle only get and post requests, while the rest
      // will not be captured and propagated further
      req.setYield(true);
      return;
    }
    const path = req.getUrl().substring(prefixTrimLength);
    const query = new URLSearchParams(decodeURIComponent(req.getQuery()));

    const headers: Record<string, string> = {};
    req.forEach((key, value) => {
      headers[key] = value;
    });

    // new request object needs to be created, because socket
    // can only be accessed synchronously, after await it cannot be accessed
    const request: UWebSocketsRequestObject = {
      headers,
      method,
      query,
      path,
      getCookies: getCookieFn(headers),
    };

    const resOverride = {
      headers: new Map<string, string>(),
      cookies: [] as string[],
      status: 0,
    };

    const response: UWebSocketsResponseObject = {
      setCookie: (
        name: string,
        value: string,
        opts?: CookieSerializeOptions
      ) => {
        const serialized = cookie.serialize(name, value, opts); //.substring(12); //remove the "Set-Cookie: "
        resOverride.cookies.push(serialized);
      },
      setStatus: (status: number) => {
        resOverride.status = status;
      },
      setHeader: (key: string, value: string) => {
        resOverride.headers.set(key, value);
      },
    };

    const bodyResult = await readPostBody(method, res);

    // req is no longer available!

    const createContext = async function _(): Promise<
      inferRouterContext<TRouter>
    > {
      //res could be proxied here
      return await opts.createContext?.({
        uWs: uWsApp,
        req: request,
        res: response,
      });
    };

    const internalReqObj: HTTPRequest = {
      method,
      headers,
      query,
      body: bodyResult.ok ? bodyResult.data : undefined,
    };

    // TODO batching, onError options need implementation.
    const result = await resolveHTTPResponse({
      path,
      createContext,
      router: opts.router,
      req: internalReqObj,
      error: bodyResult.ok ? null : bodyResult.error,
    });

    // user returned already, do nothing
    res.cork(() => {
      if (resOverride.status != 0) {
        res.writeStatus(resOverride.status.toString());
      } else if ('status' in result) {
        res.writeStatus(result.status.toString());
      } else {
        // assume something went bad, should never happen?
        throw new Error('No status to send');

        // res.writeStatus('500 INTERNAL SERVER ERROR');
        // res.end();
        // return;
      }

      //send all cookies
      resOverride.cookies.forEach((value) => {
        res.writeHeader('Set-Cookie', value);
      });

      resOverride.headers.forEach((value, key) => {
        res.writeHeader(key, value);
      });

      for (const [key, value] of Object.entries(result.headers ?? {})) {
        if (typeof value === 'undefined') {
          continue;
        }
        // make sure to never override user defined headers
        // cookies are an exception
        if (resOverride.headers.has(key)) continue;

        // not sure why it could be an array. This code path is not tested
        // maybe its duplicates for the same key? like multiple "Set-Cookie"
        if (Array.isArray(value))
          value.forEach((header) => {
            res.writeHeader(key, header);
          });
        else res.writeHeader(key, value);
      }

      //now send user headers
      if (result.body) res.write(result.body);
      res.end();
    });
  };

  uWsApp.any(pathPrefix + '/*', handler);
}
