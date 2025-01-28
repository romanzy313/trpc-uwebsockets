import type { TemplatedApp, HttpRequest, HttpResponse } from 'uWebSockets.js';

import { type UWsHandlerOptions, uWsRequestHandler } from './uWsRequestHandler';
import {
  // type NodeHTTPCreateContextFnOption,
  type NodeHTTPCreateContextFnOptions,
} from '@trpc/server/adapters/node-http';
import type { AnyRouter } from '@trpc/server';
import { applyWSSHandler, WSSHandlerOptions } from './websockets';

export interface UWsTRPCPluginOptions<TRouter extends AnyRouter> {
  prefix?: string;
  useWebsockets?: boolean;
  // middleware?: ConnectMiddleware; //TODO
  // TODO: UWSBuiltInOpts from applyWsHandler.ts
  trpcOptions: UWsHandlerOptions<TRouter, HttpRequest, HttpResponse>;
}

export type CreateUWsContextOptions = NodeHTTPCreateContextFnOptions<
  HttpRequest,
  HttpResponse
>;

export function uWsTRPCPlugin<TRouter extends AnyRouter>(
  app: TemplatedApp,
  opts: UWsTRPCPluginOptions<TRouter>
) {
  const prefix = opts.prefix ?? '';

  const handler = async (res: HttpResponse, req: HttpRequest) => {
    const url = req.getUrl().substring(prefix.length + 1);
    await uWsRequestHandler({
      ...opts.trpcOptions,
      req: req,
      res: res,
      path: url,
    });
  };

  app.get(prefix + '/*', handler);
  app.post(prefix + '/*', handler);

  // if (opts.useWebsockets) {
  //   throw new Error('TODO');
  //   const trpcOptions =
  //     opts.trpcOptions as unknown as WSSHandlerOptions<AnyRouter>;
  //   // opts.trpcOptions as unknown as WSSHandlerOptions<TRouter>;
  //   applyWSSHandler({
  //     ...trpcOptions,
  //   });
  // }

  // if (opts.useWSS) {
  //   const trpcOptions =
  //     opts.trpcOptions as unknown as WSSHandlerOptions<TRouter>;

  //   const onConnection = getWSConnectionHandler<TRouter>({
  //     ...trpcOptions,
  //   });

  //   fastify.get(prefix ?? '/', { websocket: true }, async (socket, req) => {
  //     await onConnection(socket, req.raw);
  //     if (trpcOptions?.keepAlive?.enabled) {
  //       const { pingMs, pongWaitMs } = trpcOptions.keepAlive;
  //       handleKeepAlive(socket, pingMs, pongWaitMs);
  //     }
  //   });
  // }
}
