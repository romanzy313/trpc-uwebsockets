import { test, expect, describe } from 'vitest';
import uWs from 'uWebSockets.js';

// source: packages/server/src/adapters/node-http/incomingMessageToRequest.test.ts

// this is needed to show nodes internal errors
// source: https://stackoverflow.com/questions/78946606/use-node-trace-warnings-to-show-where-the-warning-was-created
// process.on('warning', (warning) => {
//   console.warn('warning stacktrace - ' + warning.stack);
// });

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

import { decorateHttpResponse, uWsToRequest } from './fetchCompat';

function createServer(opts: { maxBodySize: number | null }) {
  type Handler = (req: Request) => Promise<void>;

  let rejectHandler: null | ((err: any) => void) = null;
  let resolveHandler: null | (() => void) = null;
  let handle: Handler | null = null;

  const app = uWs.App();

  app.any('/*', async (res, req) => {
    const resDecorated = decorateHttpResponse(res);

    const request = uWsToRequest(req, resDecorated, opts);
    await handle!(request).then(resolveHandler).catch(rejectHandler);
    res.end();
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
      // donest need to be async, but for compat
      if (!socket) {
        throw new Error('could not close socket as socket is already closed');
      }
      uWs.us_listen_socket_close(socket);
      socket = null;
    },
    fetch: async (
      opts: RequestInit & {
        path?: string;
      },
      _handle: (request: Request) => Promise<void>
    ) => {
      handle = _handle;

      const promise = new Promise<void>((resolve, reject) => {
        resolveHandler = resolve;
        rejectHandler = reject;
      });

      await fetch(`http://localhost:${port}${opts.path ?? ''}`, {
        ...opts,
      });
      await promise;
    },
  };
}

describe('request', () => {
  test.sequential('basic GET', async () => {
    const server = createServer({ maxBodySize: null });
    await server.fetch({}, async (request) => {
      expect(request.method).toBe('GET');
    });
    await server.close();
  });

  test.sequential('basic POST', async () => {
    const server = createServer({ maxBodySize: null });

    await server.fetch(
      {
        method: 'POST',
      },
      async (request) => {
        expect(request.method).toBe('POST');
      }
    );

    await server.close();
  });

  test.sequential('POST with body', async () => {
    const server = createServer({ maxBodySize: null });

    {
      // handles small text

      await server.fetch(
        {
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

  test.sequential('POST with body and maxBodySize', async () => {
    const server = createServer({ maxBodySize: 10 });
    {
      // exceeds

      await server.fetch(
        {
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

  test.sequential('retains url and search params', async () => {
    const server = createServer({ maxBodySize: null });

    {
      // with search params
      await server.fetch(
        {
          method: 'GET',
          path: '/?hello=world',
        },
        async (request) => {
          const url = new URL(request.url);
          expect(url.pathname).toBe('/');
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
          path: '/',
        },
        async (request) => {
          const url = new URL(request.url);
          expect(url.pathname).toBe('/');
          expect(url.searchParams.size).toBe(0);
        }
      );
    }
    await server.close();
  });

  // testing aborts without mocks...is painful...
  // TODO: recreate the slow request in a same way as is done with slow response
  test.sequential('aborted requests are handled', async () => {
    expect.assertions(1);

    const server = createServer({ maxBodySize: null });

    const body = '0'.repeat(2 ** 7);
    const controller = new AbortController();
    controller.abort(); // start with aborted signal already

    try {
      await server.fetch(
        {
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
  test.sequential('aborted requests in flight are handled', async () => {
    expect.assertions(1);

    const server = createServer({ maxBodySize: null });

    const body = '0'.repeat(2 ** 24);
    const controller = new AbortController();

    console.time('large-body');

    try {
      setTimeout(() => {
        controller.abort(); // start with aborted signal already
      }, 5);
      await server.fetch(
        {
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

    console.timeEnd('large-body');

    await server.close();
  });
});
