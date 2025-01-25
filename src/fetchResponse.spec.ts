import { test, expect, describe } from 'vitest';
import uWs from 'uWebSockets.js';

// source: packages/server/src/adapters/node-http/incomingMessageToRequest.test.ts

// this is needed to show nodes internal errors
// source: https://stackoverflow.com/questions/78946606/use-node-trace-warnings-to-show-where-the-warning-was-created
process.on('warning', (warning) => {
  console.warn('warning stacktrace - ' + warning.stack);
});

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

import {
  decorateHttpResponse,
  uWsSendResponse,
  uWsSendResponseStreamed,
} from './fetchCompat';

function createServer(opts: { maxBodySize: number | null }) {
  const app = uWs.App();

  app.get('/empty', async (res, _req) => {
    const resDecorated = decorateHttpResponse(res);

    res.onAborted(() => {
      resDecorated.aborted = true;
    });

    const resFetch = new Response('', {
      status: 200,
    });

    await uWsSendResponseStreamed(resFetch, resDecorated);
  });

  app.get('/regular', async (res, _req) => {
    const resDecorated = decorateHttpResponse(res);

    res.onAborted(() => {
      resDecorated.aborted = true;
    });

    const headers = new Headers();
    headers.append('content-type', 'vi/test');
    headers.append('set-cookie', 'one=1');
    headers.append('set-cookie', 'two=2');

    const resFetch = new Response('hello world', {
      status: 200,
      statusText: '200 OK',
      headers: headers,
    });

    await uWsSendResponse(resDecorated, resFetch);
  });
  app.get('/streamed', async (res, _req) => {
    const resDecorated = decorateHttpResponse(res);

    res.onAborted(() => {
      resDecorated.aborted = true;
    });

    const headers = new Headers();
    headers.append('content-type', 'vi/test');
    headers.append('set-cookie', 'one=1');
    headers.append('set-cookie', 'two=2');

    const fetchRes = new Response('hello world', {
      status: 200,
      statusText: '200 OK',
      headers: headers,
    });

    await uWsSendResponseStreamed(fetchRes, resDecorated);
  });

  app.get('/slow/:size/:count/:sleepMs', async (res, req) => {
    const resDecorated = decorateHttpResponse(res);

    res.onAborted(() => {
      resDecorated.aborted = true;
    });
    const size = parseInt(req.getParameter('size')!);
    const count = parseInt(req.getParameter('count')!);
    const sleepMs = parseInt(req.getParameter('sleepMs')!);

    const stream = new ReadableStream({
      start(controller) {
        let i = 0;
        const enqueueChunk = () => {
          if (i < count) {
            // console.log('loop i', i, 'count', count, 'sleepMs', sleepMs);
            controller.enqueue('A'.repeat(size));
            i++;
            setTimeout(enqueueChunk, sleepMs);
          } else {
            // console.log('loop closing!', 'count', count);
            controller.close();
          }
        };

        enqueueChunk();
      },
      cancel() {
        console.log('SLOW RESPONSE cancel() was called');
        console.log('doing nothing for now');
        // stop = true;
      },
    });

    const fetchRes = new Response(stream, {
      status: 200,
    });

    await uWsSendResponseStreamed(fetchRes, resDecorated);
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
      }
    ) => {
      return await fetch(`http://localhost:${port}${opts.path ?? ''}`, {
        ...opts,
      });
    },
  };
}

describe('response', () => {
  test.sequential('empty body', async () => {
    const server = createServer({ maxBodySize: null });
    const res = await server.fetch({
      path: '/empty',
      method: 'GET',
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBe(0);

    await server.close();
  });

  test.sequential('regular', async () => {
    const server = createServer({ maxBodySize: null });
    const res = await server.fetch({
      path: '/regular',
      method: 'GET',
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('vi/test');
    expect(res.headers.get('set-cookie')).toBe('one=1, two=2');

    expect(res.headers.has('content-length')).toBe(true);

    await server.close();
  });

  test.sequential('streamed', async () => {
    const server = createServer({ maxBodySize: null });
    const res = await server.fetch({
      path: '/streamed',
      method: 'GET',
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('vi/test');
    expect(res.headers.get('set-cookie')).toBe('one=1, two=2');

    expect(res.headers.get('transfer-encoding')).toBe('chunked');

    await server.close();
  });

  test.sequential('large streamed', async () => {
    const server = createServer({ maxBodySize: null });
    const size = 2 ** 20;
    const count = 10;
    const timeMs = 0;

    console.time('large streamed');

    const res = await server.fetch({
      path: `/slow/${size}/${count}/${timeMs}`,
      method: 'GET',
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBe(size * count);

    console.timeEnd('large streamed');

    await server.close();
  });

  test.sequential('slow streamed', async () => {
    const server = createServer({ maxBodySize: null });

    const size = 10;
    const count = 5;
    const sleepMs = 20;

    const res = await server.fetch({
      path: `/slow/${size}/${count}/${sleepMs}`,
      method: 'GET',
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBe(size * count);
  });

  test.sequential('slow aborted', async () => {
    expect.assertions(1);

    const server = createServer({ maxBodySize: null });

    const size = 100;
    const count = 5;
    const sleepMs = 20;

    const controller = new AbortController();

    try {
      const res = await server.fetch({
        path: `/slow/${size}/${count}/${sleepMs}`,
        method: 'GET',
        signal: controller.signal,
      });
      setTimeout(() => {
        controller.abort();
      }, 40);

      // important to actually listen for the body
      // if this is missing then the test is over and AbortError is not triggered
      await res.text();
    } catch (err: any) {
      expect(err.name).toBe('AbortError');
    }
  });

  test.sequential('aborted request', async () => {
    expect.assertions(1);

    const server = createServer({ maxBodySize: null });

    const size = 2 ** 22;
    const controller = new AbortController();
    controller.abort(); // start with aborted signal already

    try {
      const res = await server.fetch({
        path: `/large/${size}`,
        method: 'GET',
        signal: controller.signal,
      });
      await res.text();
    } catch (err: any) {
      expect(err.name).toBe('AbortError');
    }

    await server.close();
  });

  test.sequential('aborted request in flight', async () => {
    expect.assertions(1);

    const server = createServer({ maxBodySize: null });

    const size = 2 ** 24;
    const controller = new AbortController();
    controller.abort(); // start with aborted signal already

    try {
      const res = await server.fetch({
        path: `/large/${size}`,
        method: 'GET',
        signal: controller.signal,
      });
      setTimeout(() => {
        controller.abort(); // start with aborted signal already
      }, 5);
      await res.text();
    } catch (err: any) {
      expect(err.name).toBe('AbortError');
    }

    await server.close();
  });
});
