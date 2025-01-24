import type { TemplatedApp, HttpRequest, HttpResponse } from 'uWebSockets.js';

import {
  type FastifyHandlerOptions,
  fastifyRequestHandler,
} from './uWsRequestHandler';
import {
  // type NodeHTTPCreateContextFnOption,
  type NodeHTTPCreateContextFnOptions,
} from '@trpc/server/adapters/node-http';
import type { AnyRouter } from '@trpc/server';

export interface FastifyTRPCPluginOptions<TRouter extends AnyRouter> {
  prefix?: string;
  useWSS?: boolean;
  // middleware?: ConnectMiddleware; //TODO
  // TODO: UWSBuiltInOpts from applyWsHandler.ts
  maxBodySize?: number;
  trpcOptions: FastifyHandlerOptions<TRouter, HttpRequest, HttpResponse>;
}

export type CreateFastifyContextOptions = NodeHTTPCreateContextFnOptions<
  HttpRequest,
  HttpResponse
>;

export function fastifyTRPCPlugin<TRouter extends AnyRouter>(
  fastify: TemplatedApp,
  opts: FastifyTRPCPluginOptions<TRouter>
) {
  const prefix = opts.prefix ?? '';

  const handler = async (res: HttpResponse, req: HttpRequest) => {
    const url = req.getUrl().substring(prefix.length + 1);
    await fastifyRequestHandler({
      ...opts.trpcOptions,
      req: req,
      res: res,
      path: url,
    });
  };

  fastify.get(prefix + '/*', handler);
  fastify.post(prefix + '/*', handler);

  // fastify.all(`${prefix}/:path`, async (req, res) => {
  //   const path = (req.params as any).path;
  //   await fastifyRequestHandler({ ...opts.trpcOptions, req, res, path });
  // });

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
