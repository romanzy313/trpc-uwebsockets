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

const getPostBody = (res: HttpResponse, maxBodySize: number | null) => {
  return new Promise<
    | { data: Buffer; ok: true; preprocessed: boolean }
    | { error: TRPCError; ok: false }
  >((resolve) => {
    let buffer: Buffer | undefined;
    let size = 0;

    res.onData((ab, isLast) => {
      size += ab.byteLength;
      if (maxBodySize && size >= maxBodySize) {
        resolve({
          ok: false,
          error: new TRPCError({ code: 'PAYLOAD_TOO_LARGE' }),
        });
      }

      //resolve if there is only one chunk
      if (buffer === undefined && isLast) {
        resolve({
          ok: true,
          data: Buffer.from(ab),
          preprocessed: false,
        });
        return;
      }

      const chunk = Buffer.from(ab);

      if (buffer) {
        //else accumulate
        buffer = Buffer.concat([buffer, chunk]);
      } else buffer = Buffer.concat([chunk]);

      if (isLast) {
        resolve({
          ok: true,
          data: buffer,
          preprocessed: false,
        });
      }
    });

    res.onAborted(() => {
      resolve({
        ok: false,
        error: new TRPCError({ code: 'CLIENT_CLOSED_REQUEST' }),
      });
    });
  });
};

export async function uWsToRequest(
  req: HttpRequest,
  res: HttpResponseDecorated,
  opts: {
    /**
     * Max body size in bytes. If the body is larger than this, the request will be aborted
     */
    maxBodySize: number | null;
  }
): Promise<Request> {
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
    const parsedBody = await getPostBody(res, opts.maxBodySize);
    if (parsedBody.ok) {
      init.body = parsedBody.data;
    } else {
      init.body = new ReadableStream({
        start(controller) {
          controller.error(parsedBody.error);
        },
        cancel() {
          res.close();
        },
      });
    }
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
