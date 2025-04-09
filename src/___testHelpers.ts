import { vi } from 'vitest';

import { AnyTRPCRouter } from '@trpc/server';
import {
  applyWebsocketHandler,
  WebSocketBehaviorOptions,
  WebsocketsKeepAlive,
} from './websockets';
import { observable } from '@trpc/server/observable';

import uWs from 'uWebSockets.js';
import {
  applyRequestHandler,
  CreateContextOptions,
  CreateHandlerOptions,
} from './requestHandler';
import type {
  HTTPHeaders,
  TRPCLink,
  WebSocketClientOptions,
} from '@trpc/client';
import {
  createTRPCClient,
  createWSClient,
  httpBatchLink,
  httpBatchStreamLink,
  httpSubscriptionLink,
  wsLink,
} from '@trpc/client';

import { EventSourcePolyfill } from 'event-source-polyfill';
global.EventSource = EventSourcePolyfill;

export interface ServerOptions<AppRouter extends AnyTRPCRouter> {
  appRouter: AppRouter;
  prefix?: string;
  createContext?: (opts: CreateContextOptions) => Promise<any>;
  uWsBehaviorOptions?: WebSocketBehaviorOptions;
  keepAlive?: WebsocketsKeepAlive;
}

function createServer<AppRouter extends AnyTRPCRouter>(
  opts: ServerOptions<AppRouter>
) {
  const prefix = opts.prefix ?? '/trpc';

  const instance = uWs.App();

  const router = opts.appRouter;

  const onServerErrorSpy = vi.fn();

  applyRequestHandler(instance, {
    prefix,
    ssl: false,
    trpcOptions: {
      router,
      createContext: opts.createContext ?? (() => ({})),
      onError(data) {
        onServerErrorSpy(data);
      },
      responseMeta() {
        return {
          headers: {
            'Access-Control-Allow-Origin': '*',
          },
        };
      },
    } satisfies CreateHandlerOptions<AppRouter>['trpcOptions'],
  });
  applyWebsocketHandler(instance, {
    prefix,
    ssl: false,
    router,
    createContext: opts.createContext ?? (() => ({})),
    onError(data) {
      onServerErrorSpy(data);
    },
    uWsBehaviorOptions: opts.uWsBehaviorOptions,
    keepAlive: opts.keepAlive,
  });

  instance.get('/hello', async (res) => {
    res.end('Hello world');
  });
  instance.post('/hello', async (res) => {
    res.end(JSON.stringify({ hello: 'POST', body: 'TODO, why?' }));
  });
  instance.ws('/ws', {
    message: (client, rawMsg) => {
      client.send(rawMsg);
    },
  });
  instance.ws('/pubsub', {
    open: (client) => {
      const ok = client.subscribe('topic');
      if (!ok) {
        throw new Error("assertion: failed to subscribe to 'topic'");
      }
    },
  });

  instance.any('/*', (res) => {
    res.writeStatus('404 NOT FOUND');
    res.end();
  });

  let socket: uWs.us_listen_socket | false | null = null;

  instance.listen('0.0.0.0', 0, (token) => {
    socket = token;
  });

  if (!socket) {
    throw new Error('could not make a socket');
  }

  const port = uWs.us_socket_local_port(socket);

  return {
    stop() {
      if (!socket) {
        throw new Error('could not close socket as socket is already closed');
      }
      uWs.us_listen_socket_close(socket);
      socket = null;
    },
    port,
    instance,
    onServerErrorSpy,
  };
}

function makeLinkSpy() {
  const orderedResults: number[] = [];
  const linkSpy: TRPCLink<any> = () => {
    // here we just got initialized in the app - this happens once per app
    // useful for storing cache for instance
    return ({ next, op }) => {
      // this is when passing the result to the next link
      // each link needs to return an observable which propagates results
      return observable((observer) => {
        const unsubscribe = next(op).subscribe({
          next(value) {
            const data = value.result.data;
            if (data !== undefined) {
              orderedResults.push(data as number);
            }
            observer.next(value);
          },
          error: observer.error,
        });
        return unsubscribe;
      });
    };
  };

  return {
    orderedResults,
    linkSpy,
  };
}

interface ClientOptions {
  prefix?: string;
  wsClientOptions?: Omit<WebSocketClientOptions, 'url'> | undefined;
  queryParams?: Record<string, string> | undefined;
  headers?: HTTPHeaders | undefined;
  port: number;
}

function toQueryString(queryParams: Record<string, string>) {
  const raw = new URLSearchParams(queryParams).toString();
  return raw.length == 0 ? '' : `?${raw}`;
}

function createClientWs<TRouter extends AnyTRPCRouter>(
  router: TRouter,
  opts: ClientOptions
) {
  const prefix = opts.prefix ?? '/trpc';
  const transformer = router._def._config.transformer as any;

  const qs = toQueryString(opts.queryParams ?? {});
  const host = `localhost:${opts.port}${prefix}${qs}`;
  const wsClient = createWSClient({
    retryDelayMs: () => 99999, // never retry by default
    ...opts.wsClientOptions,
    url: `ws://${host}`,
  });
  const { orderedResults, linkSpy } = makeLinkSpy();
  const client = createTRPCClient<TRouter>({
    links: [linkSpy, wsLink({ client: wsClient, transformer })],
  });

  return { client, wsClient, orderedResults };
}

function createClientBatchStream<TRouter extends AnyTRPCRouter>(
  router: TRouter,
  opts: ClientOptions
) {
  const prefix = opts.prefix ?? '/trpc';
  const transformer = router._def._config.transformer as any;

  const qs = toQueryString(opts.queryParams ?? {});
  const host = `localhost:${opts.port}${prefix}${qs}`;
  const { orderedResults, linkSpy } = makeLinkSpy();
  const client = createTRPCClient<TRouter>({
    links: [
      linkSpy,
      httpBatchStreamLink({
        url: `http://${host}`,
        headers: opts.headers,
        transformer,
      }),
    ],
  });

  return { client, orderedResults };
}

function createClientBatch<TRouter extends AnyTRPCRouter>(
  router: TRouter,
  opts: ClientOptions
) {
  const prefix = opts.prefix ?? '/trpc';
  const transformer = router._def._config.transformer as any;

  const qs = toQueryString(opts.queryParams ?? {});
  const host = `localhost:${opts.port}${prefix}${qs}`;
  const client = createTRPCClient<TRouter>({
    links: [
      httpBatchLink({
        url: `http://${host}`,
        headers: opts.headers,
        transformer,
      }),
    ],
  });

  return { client };
}

function createClientSse<TRouter extends AnyTRPCRouter>(
  router: TRouter,
  opts: ClientOptions
) {
  const prefix = opts.prefix ?? '/trpc';
  const transformer = router._def._config.transformer as any;

  const qs = toQueryString(opts.queryParams ?? {});
  const host = `localhost:${opts.port}${prefix}${qs}`;

  const { orderedResults, linkSpy } = makeLinkSpy();
  const client = createTRPCClient<TRouter>({
    links: [
      linkSpy,
      httpSubscriptionLink({
        url: `http://${host}`,
        connectionParams: opts.wsClientOptions?.connectionParams,
        // ponyfill EventSource
        EventSource: EventSourcePolyfill as any,
        transformer,
      }),
    ],
  });
  return { client, orderedResults };
}

export function testFactory<AppRouter extends AnyTRPCRouter>(
  serverOptions: ServerOptions<AppRouter>
) {
  const { instance, port, stop, onServerErrorSpy } = createServer({
    ...serverOptions,
  });

  return {
    server: instance,
    stop,
    onServerErrorSpy,
    port,
    opts: serverOptions,
    fetch(path: string, opts: RequestInit) {
      return fetch(`http://localhost:${port}${path}`, { ...opts });
    },
    clientBatchStream(clientOptions?: Partial<ClientOptions> | undefined) {
      return createClientBatchStream(serverOptions.appRouter, {
        ...clientOptions,
        port,
      });
    },
    clientBatch(clientOptions?: Partial<ClientOptions> | undefined) {
      return createClientBatch(serverOptions.appRouter, {
        ...clientOptions,
        port,
      });
    },
    clientSse(clientOptions?: Partial<ClientOptions> | undefined) {
      return createClientSse(serverOptions.appRouter, {
        ...clientOptions,
        port,
      });
    },
    clientWs(clientOptions?: Partial<ClientOptions> | undefined) {
      return createClientWs(serverOptions.appRouter, {
        ...clientOptions,
        port,
      });
    },
  };
}
