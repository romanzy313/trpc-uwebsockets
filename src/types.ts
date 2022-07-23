import { AnyRouter, inferRouterContext } from '@trpc/server';
import { HttpRequest, HttpResponse, TemplatedApp } from 'uWebSockets.js';
import { CookieParseOptions, CookieSerializeOptions } from 'cookie';

export type UWebSocketsCreateHandlerOptions<TRouter extends AnyRouter> = {
  /* trpc router */
  router: TRouter;
  /* optional create context */
  createContext?: (
    opts: UWebSocketsCreateContextOptions
  ) => Promise<inferRouterContext<TRouter>> | inferRouterContext<TRouter>;
  /* optional pre-request handler. Useful for dealing with CORS */
  onRequest?: (
    req: UWebSocketsRequestObject,
    res: UWebSocketsResponseObject
  ) => void;
};

export type UWebSocketsRequestObject = {
  headers: Record<string, string>;
  method: 'POST' | 'GET';
  query: URLSearchParams;
  path: string;
  getCookies: (opts?: CookieParseOptions) => Record<string, string>;
};

// if this to be used, it needs to be proxied
export type UWebSocketsResponseObject = {
  setCookie(key: string, value: string, opts?: CookieSerializeOptions): void;
  setStatus(status: number): void;
  setHeader(key: string, value: string): void;
};

export type UWebSocketsCreateContextOptions = {
  req: UWebSocketsRequestObject;
  uWs: TemplatedApp;
  res: UWebSocketsResponseObject;
};
