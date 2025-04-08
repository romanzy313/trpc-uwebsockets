import { HttpResponse, HttpRequest } from 'uWebSockets.js';
import { TRPCError } from '@trpc/server';

// this implements uWs compatibility with fetch api as its needed for v11 of trpc
// mostly following /trpc/packages/server/src/adapters/node-http/incomingMessageToRequest.ts

// response with extra parameters
// ssl specifies if https is used
export type HttpResponseDecorated = HttpResponse & {
  aborted: boolean;
  ssl: boolean;
};

export function decorateHttpResponse(
  res: HttpResponse,
  ssl = false
): HttpResponseDecorated {
  const resDecorated: HttpResponseDecorated = res as any;
  resDecorated.aborted = false;
  resDecorated.ssl = ssl;

  return resDecorated;
}

export function uWsToRequestNoBody(
  req: HttpRequest,
  res: HttpResponseDecorated
): Request {
  const headers = createHeaders(req);
  const method = req.getCaseSensitiveMethod().toUpperCase();
  const isSsl = res.ssl;

  const url = createURL(req, isSsl ? 'https' : 'http');

  const init: RequestInit = {
    headers: headers,
    method: method,
  };

  const request = new Request(url, init);

  return request;
}

export function uWsToRequest(
  req: HttpRequest,
  res: HttpResponseDecorated,
  opts: {
    /**
     * Max body size in bytes. If the body is larger than this, the request will be aborted
     */
    maxBodySize: number | null;
  }
): Request {
  const ac = new AbortController();

  const onAbort = () => {
    res.aborted = true;
    ac.abort();
  };
  res.onAborted(onAbort);

  const headers = createHeaders(req);
  const method = req.getCaseSensitiveMethod().toUpperCase();
  const isSsl = res.ssl;

  const url = createURL(req, isSsl ? 'https' : 'http');

  const init: RequestInit = {
    headers: headers,
    method: method,
    signal: ac.signal,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = createBody(res, opts);
    init.duplex = 'half';
  }

  const request = new Request(url, init);

  return request;
}

function createHeaders(req: HttpRequest): Headers {
  const headers = new Headers();

  req.forEach((key, value) => {
    /* istanbul ignore next -- @preserve */
    if (key.startsWith(':')) {
      // Skip HTTP/2 pseudo-headers
      return;
    }

    if (value.length != 0) {
      headers.append(key, value);
    }
  });

  return headers;
}

export function createURL(req: HttpRequest, protocol: string): URL {
  try {
    const host = req.getHeader('host') ?? 'localhost';
    const path = req.getUrl();
    const qs = req.getQuery();

    if (qs) {
      return new URL(`${path}?${qs}`, `${protocol}://${host}`);
    } else {
      return new URL(path, `${protocol}://${host}`);
    }
  } catch (cause) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid URL',
      cause,
    });
  }
}

function createBody(
  res: HttpResponse,
  opts: {
    maxBodySize: number | null;
  }
): RequestInit['body'] {
  let size = 0;
  let hasClosed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      res.onData((tempChunk, isLast) => {
        if (hasClosed) return;

        // This copies the buffer *immediately* and avoids using a detached buffer
        const chunk = new Uint8Array(tempChunk.byteLength);
        chunk.set(new Uint8Array(tempChunk)); // must be done before enqueue
        size += chunk.byteLength;

        if (!opts.maxBodySize || size <= opts.maxBodySize) {
          controller.enqueue(chunk);

          if (isLast) {
            hasClosed = true;
            controller.close();
          }
        } else {
          hasClosed = true;
          controller.error(new TRPCError({ code: 'PAYLOAD_TOO_LARGE' }));
        }
      });

      res.onAborted(() => {
        if (!hasClosed) {
          hasClosed = true;
          controller.error(new TRPCError({ code: 'CLIENT_CLOSED_REQUEST' }));
        }
      });
    },
    cancel() {
      res.cork(() => {
        res.close();
      });
    },
  });
}

export async function uWsSendResponse(
  res: HttpResponseDecorated,
  fetchRes: Response
): Promise<void> {
  const unsteamed_text = await fetchRes.text();

  if (res.aborted) return;
  res.cork(() => {
    res.writeStatus(fetchRes.status.toString());

    fetchRes.headers.forEach((value, key) => {
      res.writeHeader(key, value);
    });

    res.end(unsteamed_text);
  });
}

export async function uWsSendResponseStreamed(
  fetchRes: Response,
  res: HttpResponseDecorated
): Promise<void> {
  if (res.aborted) return;

  res.cork(() => {
    res.writeStatus(fetchRes.status.toString());
    fetchRes.headers.forEach((value, key) => {
      res.writeHeader(key, value);
    });
  });

  if (fetchRes.body) {
    const reader = fetchRes.body.getReader();

    while (true) {
      const { value, done } = await reader.read();

      if (res.aborted) {
        return;
      }

      if (done) {
        res.cork(() => {
          res.end();
        });
        return;
      }

      res.cork(() => {
        res.write(value);
      });
    }
  } else {
    res.cork(() => {
      res.end();
    });
  }
}
