// major refactor
// following packages/server/src/adapters/fastify/fastifyRequestHandler.ts

import type { HttpRequest, HttpResponse } from 'uWebSockets.js';

// @trpc/server
import type { AnyRouter } from '@trpc/server';
// @trpc/server/http
import {
  resolveResponse,
  type HTTPBaseHandlerOptions,
  type ResolveHTTPRequestOptionsContextFn,
} from '@trpc/server/http';
// @trpc/server/node-http
import {
  type NodeHTTPCreateContextOption,
  // type NodeHTTPCreateContextFnOptions,
} from '@trpc/server/adapters/node-http';

import { decorateHttpResponse } from './fetchCompat';
import { uWsToRequest, uWsSendResponse } from './fetchCompat';

export type UWsHandlerOptions<
  TRouter extends AnyRouter,
  TRequest extends HttpRequest,
  TResponse extends HttpResponse
> = HTTPBaseHandlerOptions<TRouter, TRequest> &
  NodeHTTPCreateContextOption<TRouter, TRequest, TResponse>;

type UWsRequestHandlerOptions<
  TRouter extends AnyRouter,
  TRequest extends HttpRequest,
  TResponse extends HttpResponse
> = UWsHandlerOptions<TRouter, TRequest, TResponse> & {
  req: TRequest;
  res: TResponse;
  path: string;
};

export async function uWsRequestHandler<
  TRouter extends AnyRouter,
  TRequest extends HttpRequest,
  TResponse extends HttpResponse
>(opts: UWsRequestHandlerOptions<TRouter, TRequest, TResponse>) {
  const createContext: ResolveHTTPRequestOptionsContextFn<TRouter> = async (
    innerOpts
  ) => {
    return await opts.createContext?.({
      ...opts,
      ...innerOpts,
    });
  };

  const resDecorated = decorateHttpResponse(opts.res);

  // const incomingMessage: UniversalIncomingMessage = opts.req.raw;

  const req = uWsToRequest(opts.req, resDecorated, {
    maxBodySize: null, // TODO
  });
  // // monkey-path body to the IncomingMessage
  // if ('body' in opts.req) {
  //   incomingMessage.body = opts.req.body;
  // }
  // const req = incomingMessageToRequest(incomingMessage, opts.res.raw, {
  //   maxBodySize: null,
  // });

  const res = await resolveResponse({
    ...opts,
    req,
    error: null,
    createContext,
    onError(o) {
      opts?.onError?.({
        ...o,
        req: opts.req,
      });
    },
  });

  await uWsSendResponse(resDecorated, res);
}

// import { getPostBody } from './utils';
// import {
//   uHTTPRequestHandlerOptions,
//   WrappedHTTPRequest,
//   WrappedHTTPResponse,
// } from './types';
// import {
//   resolveHTTPResponse,
//   type HTTPRequest,
//   type ResolveHTTPRequestOptionsContextFn,
// } from '@trpc/server/http';

// import type { AnyTRPCRouter } from '@trpc/server';

// export async function uWsHTTPRequestHandler<
//   TRouter extends AnyTRPCRouter,
//   TRequest extends WrappedHTTPRequest,
//   TResponse extends WrappedHTTPResponse
// >(opts: uHTTPRequestHandlerOptions<TRouter, TRequest, TResponse>) {
//   const handleViaMiddleware = opts.middleware ?? ((_req, _res, next) => next());
//   return handleViaMiddleware(opts.req, opts.res, async (err) => {
//     if (err) throw err;

//     const createContext: ResolveHTTPRequestOptionsContextFn<TRouter> = async (
//       innerOpts
//     ) => {
//       return opts.createContext?.({
//         req: opts.req,
//         res: opts.res,
//         ...innerOpts,
//       });
//     };

//     // this may not be needed
//     const query = new URLSearchParams(opts.req.query);

//     const { res, req } = opts;

//     if (res.aborted) return;

//     const bodyResult = await getPostBody(req.method, res, opts.maxBodySize);

//     if (res.aborted) return;

//     const reqObj: HTTPRequest = {
//       method: opts.req.method!,
//       headers: opts.req.headers,
//       query,
//       body: bodyResult.ok ? bodyResult.data : undefined,
//     };

//     const result = await resolveHTTPResponse({
//       batching: opts.batching,
//       responseMeta: opts.responseMeta,
//       path: opts.path,
//       createContext,
//       router: opts.router,
//       req: reqObj,
//       error: bodyResult.ok ? null : bodyResult.error,
//       preprocessedBody: false,
//       onError(o) {
//         opts?.onError?.({
//           ...o,
//           req: opts.req,
//         });
//       },
//     });

//     if (res.aborted) return;

//     res.cork(() => {
//       res.writeStatus(result.status.toString()); // is this okay?

//       // oldschool way of writing headers
//       for (const [key, value] of Object.entries(result.headers ?? {})) {
//         if (typeof value === 'undefined') {
//           continue;
//         }
//         if (Array.isArray(value))
//           value.forEach((v) => {
//             res.writeHeader(key, v);
//           });
//         else res.writeHeader(key, value);
//       }

//       res.end(result.body);
//     });
//   });
// }
