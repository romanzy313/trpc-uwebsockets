import { AnyRouter, inferRouterContext } from '@trpc/server';
import { TemplatedApp } from 'uWebSockets.js';
import { CookieParseOptions, CookieSerializeOptions } from 'cookie';
export type UWebSocketsRegisterEndpointOptions<TRouter extends AnyRouter> = {
  router: TRouter;
  createContext?: (
    opts: UWebSocketsCreateContextOptions
  ) => Promise<inferRouterContext<TRouter>> | inferRouterContext<TRouter>;
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
