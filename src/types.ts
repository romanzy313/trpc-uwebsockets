import { AnyRouter, inferRouterContext } from '@trpc/server';
import { HttpResponse, TemplatedApp } from 'uWebSockets.js';

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
};

// if this to be used, it needs to be proxied
export type UWebSocketsResponseObject = HttpResponse;

export type UWebSocketsCreateContextOptions = {
  req: UWebSocketsRequestObject;
  uWs: TemplatedApp;
  // res: UWebSocketsResponseObject;
};
