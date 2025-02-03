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
  const url = createURL(req, res);

  const init: RequestInit = {
    headers: headers,
    method: method,
    signal: ac.signal,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = createBody(res, opts);

    // init.duplex = 'half' must be set when body is a ReadableStream, and Node follows the spec.
    // However, this property is not defined in the TypeScript types for RequestInit, so we have
    // to cast it here in order to set it without a type error.
    // See https://fetch.spec.whatwg.org/#dom-requestinit-duplex
    // @ts-expect-error this is fine
    init.duplex = 'half';
  }

  const request = new Request(url, init);

  return request;
}

function createHeaders(req: HttpRequest): Headers {
  const headers = new Headers();

  req.forEach((key, value) => {
    if (typeof key === 'string' && key.startsWith(':')) {
      // Skip HTTP/2 pseudo-headers
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (value != null) {
      headers.append(key, value);
    }
  });

  return headers;
}

function createURL(req: HttpRequest, res: HttpResponseDecorated): URL {
  try {
    const protocol = res.ssl ? 'https:' : 'http:';
    const host = req.getHeader('host') ?? 'localhost';
    const path = req.getUrl();
    const qs = req.getQuery();

    if (qs) {
      return new URL(`${path}?${qs}`, `${protocol}//${host}`);
    } else {
      return new URL(path, `${protocol}//${host}`);
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
    /**
     * Max body size in bytes. If the body is larger than this, the request will be aborted
     */
    maxBodySize: number | null;
  }
): RequestInit['body'] {
  let size = 0;
  let hasClosed = false;

  return new ReadableStream({
    start(controller) {
      const onData = (ab: ArrayBuffer, isLast: boolean) => {
        // special case of empty body
        if (size == 0 && ab.byteLength == 0 && isLast) {
          onEnd();
          return;
        }

        size += ab.byteLength;
        if (!opts.maxBodySize || size <= opts.maxBodySize) {
          controller.enqueue(new Uint8Array(ab));

          if (isLast) {
            onEnd();
          }

          return;
        }
        controller.error(
          new TRPCError({
            code: 'PAYLOAD_TOO_LARGE',
          })
        );
        hasClosed = true;
      };

      const onEnd = () => {
        if (hasClosed) {
          return;
        }
        hasClosed = true;
        controller.close();
      };

      res.onData(onData);
      res.onAborted(onEnd);
    },
    cancel() {
      res.close();
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

      if (done) {
        if (!res.aborted) {
          res.end();
        }
        return;
      }
      if (res.aborted) {
        return;
      }
      res.cork(() => {
        res.write(value);
      });
    }
  } else {
    res.end();
    return;
  }
}
