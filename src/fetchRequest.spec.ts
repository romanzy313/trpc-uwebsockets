import uWs from 'uWebSockets.js';
import { describe, expect, test } from 'vitest';

import {
  decorateHttpResponse,
  uWsSendResponseStreamed,
  uWsToRequest,
} from './fetchCompat';
// source: packages/server/src/adapters/node-http/incomingMessageToRequest.test.ts

function createServer(opts: { maxBodySize: number | null }) {
  type Handler = (req: Request) => Promise<void>;

  let rejectHandler: null | ((err: any) => void) = null;
  let resolveHandler: null | (() => void) = null;
  let handle: Handler | null = null;

  const app = uWs.App();

  app.any('/handle', async (res, req) => {
    const resDecorated = decorateHttpResponse(res);

    const request = uWsToRequest(req, resDecorated, opts);
    await handle!(request).then(resolveHandler).catch(rejectHandler);
    res.cork(() => {
      res.end();
    });
  });

  app.any('/stream', async (res, req) => {
    const resDecorated = decorateHttpResponse(res);

    const request = uWsToRequest(req, resDecorated, opts);
    const bytes = await request.bytes();

    const resFetch = new Response('hello world', {
      status: 200,
      statusText: '200 OK',
      headers: { 'request-size': bytes.length.toString() },
    });
    await uWsSendResponseStreamed(resFetch, resDecorated);
  });

  let socket: uWs.us_listen_socket | false | null = null;

  app.listen('0.0.0.0', 0, (token) => {
    socket = token;
  });

  if (!socket) {
    throw new Error('could not make a socket');
  }

  const port = uWs.us_socket_local_port(socket);
  // console.log('Listening to port ' + port);

  return {
    async close() {
      if (!socket) {
        throw new Error('could not close socket as socket is already closed');
      }
      uWs.us_listen_socket_close(socket);
      socket = null;
    },
    fetch: async (
      opts: RequestInit & {
        path: string;
      },
      _handle: (request: Request) => Promise<void>
    ) => {
      handle = _handle;

      const promise = new Promise<void>((resolve, reject) => {
        resolveHandler = resolve;
        rejectHandler = reject;
      });

      await fetch(`http://localhost:${port}${opts.path ?? '/'}`, {
        ...opts,
      });
      await promise;
    },
    fetchWithResponse: async (
      opts: RequestInit & {
        path?: string;
      }
    ) => {
      return await fetch(`http://localhost:${port}${opts.path ?? ''}`, {
        ...opts,
      });
    },
  };
}

function slowReadableStream(
  size: number,
  count: number,
  sleepMs: number
): ReadableStream {
  const body = '0'.repeat(size);

  return new ReadableStream({
    start(controller) {
      let i = 0;
      function pump() {
        if (i >= count) {
          controller.close();
          return;
        }
        setTimeout(() => {
          controller.enqueue(body);
          i++;
          pump();
        }, sleepMs);
      }
      pump();
    },
  });
}

describe('request', () => {
  test('basic GET', async () => {
    const server = createServer({ maxBodySize: null });
    await server.fetch(
      {
        path: '/handle',
      },
      async (request) => {
        expect(request.method).toBe('GET');
      }
    );
    await server.close();
  });

  test('basic POST', async () => {
    const server = createServer({ maxBodySize: null });

    await server.fetch(
      {
        path: '/handle',
        method: 'POST',
      },
      async (request) => {
        expect(request.method).toBe('POST');
      }
    );

    await server.close();
  });

  test('POST with body', async () => {
    const server = createServer({ maxBodySize: null });

    {
      // handles small text

      await server.fetch(
        {
          path: '/handle',
          method: 'POST',
          body: JSON.stringify({ hello: 'world' }),
          headers: {
            'content-type': 'application/json',
          },
        },
        async (request) => {
          expect(request.method).toBe('POST');
          expect(await request.json()).toEqual({ hello: 'world' });
        }
      );
    }
    {
      // handles a body that is long enough to come in multiple chunks

      const body = '0'.repeat(2 ** 17);
      const bodyLength = body.length;

      await server.fetch(
        {
          path: '/handle',
          method: 'POST',
          body,
        },
        async (request) => {
          expect(request.method).toBe('POST');
          expect((await request.text()).length).toBe(bodyLength);
        }
      );
    }

    await server.close();
  });

  test('POST with body and maxBodySize', async () => {
    const server = createServer({ maxBodySize: 10 });
    {
      // exceeds

      await server.fetch(
        {
          path: '/handle',
          method: 'POST',
          body: '0'.repeat(11),
        },
        async (request) => {
          expect(request.method).toBe('POST');
          await expect(
            request.text()
          ).rejects.toThrowErrorMatchingInlineSnapshot(
            `[TRPCError: PAYLOAD_TOO_LARGE]`
          );
        }
      );
    }
    {
      // not exceeds

      await server.fetch(
        {
          path: '/handle',
          method: 'POST',
          body: '0'.repeat(9),
        },
        async (request) => {
          expect(request.method).toBe('POST');
          expect(await request.text()).toBe('0'.repeat(9));
        }
      );
    }

    server.close();
  });

  test('retains url and search params', async () => {
    const server = createServer({ maxBodySize: null });

    {
      // with search params

      await server.fetch(
        {
          method: 'GET',
          path: '/handle?hello=world',
        },
        async (request) => {
          const url = new URL(request.url);
          expect(url.pathname).toBe('/handle');
          expect(url.searchParams.get('hello')).toBe('world');
          // expect(url.searchParams.size).toBe(1);
        }
      );
    }

    {
      // without search params

      await server.fetch(
        {
          method: 'GET',
          path: '/handle',
        },
        async (request) => {
          const url = new URL(request.url);
          expect(url.pathname).toBe('/handle');
          expect(url.searchParams.size).toBe(0);
        }
      );
    }
    await server.close();
  });

  test('slow requests are handled', async () => {
    const server = createServer({ maxBodySize: null });

    const readableStream = slowReadableStream(100, 3, 50);
    const res = await server.fetchWithResponse({
      path: '/stream',
      method: 'POST',
      body: readableStream,
      // @ts-expect-error needed for using the stream
      duplex: 'half',
    });

    expect(res.ok).equals(true);
    expect(res.headers.get('request-size')).equals('300');
  });

  // testing aborts without mocks...is painful...
  // TODO: recreate the slow request in a same way as is done with slow response
  test('aborted requests are handled', async () => {
    expect.assertions(1);

    const server = createServer({ maxBodySize: null });

    const body = '0'.repeat(2 ** 7);
    const controller = new AbortController();
    controller.abort(); // start with aborted signal already

    try {
      await server.fetch(
        {
          path: '/handle',
          method: 'POST',
          body,
          signal: controller.signal,
        },
        async () => {
          //
        }
      );
    } catch (err: any) {
      expect(err.name).toBe('AbortError');
    }

    await server.close();
  });

  // TODO: this is a flaky test as timeout must be handled
  // very large body of 2^24 takes about 12ms on my machine
  // so i guess this is fine
  test('aborted requests in flight are handled', async () => {
    expect.assertions(1);

    const server = createServer({ maxBodySize: null });

    const body = '0'.repeat(2 ** 24);
    const controller = new AbortController();

    // console.time('large-body');

    try {
      setTimeout(() => {
        controller.abort(); // start with aborted signal already
      }, 5);
      await server.fetch(
        {
          path: '/handle',
          method: 'POST',
          body,
          signal: controller.signal,
        },
        async () => {
          //
        }
      );
    } catch (err: any) {
      expect(err.name).toBe('AbortError');
    }

    // console.timeEnd('large-body');

    await server.close();
  });
});
