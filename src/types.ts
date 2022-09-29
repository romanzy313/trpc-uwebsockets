import { HttpRequest, HttpResponse, TemplatedApp } from 'uWebSockets.js';

import { AnyRouter } from '@trpc/server';
import {
  NodeHTTPCreateContextFnOptions,
  NodeHTTPCreateContextOption,
} from '@trpc/server/adapters/node-http';
import { HTTPBaseHandlerOptions } from '@trpc/server/dist/http/internals/types';

export type WrappedHTTPRequest = {
  headers: Record<string, string>;
  method: 'POST' | 'GET';
  query: string;
  url: string;
};

export type WrappedHTTPResponse = {
  setStatus(status: number): void;
  setHeader(key: string, value: string): void;
};

export type uHTTPHandlerOptions<TRouter extends AnyRouter> =
  HTTPBaseHandlerOptions<TRouter, WrappedHTTPRequest> & {
    maxBodySize?: number;
  } & NodeHTTPCreateContextOption<
      TRouter,
      WrappedHTTPRequest,
      WrappedHTTPResponse
    >;

export type uHTTPRequestHandlerOptions<TRouter extends AnyRouter> = {
  req: WrappedHTTPRequest;
  uRes: HttpResponse;
  path: string;
} & uHTTPHandlerOptions<TRouter>;

export type CreateContextOptions = NodeHTTPCreateContextFnOptions<
  WrappedHTTPRequest,
  WrappedHTTPResponse
>;
