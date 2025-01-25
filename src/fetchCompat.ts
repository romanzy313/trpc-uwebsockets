import { HttpResponse, HttpRequest } from 'uWebSockets.js';
import { TRPCError } from '@trpc/server';
import { isAbortError } from '@trpc/server/unstable-core-do-not-import';

// this implements uWs compatibility with fetch api as its needed for v11 of trpc
// mostly following /trpc/packages/server/src/adapters/node-http/incomingMessageToRequest.ts

// response with extra parameters
// encrypted specifies if https is used
export type HttpResponseDecorated = HttpResponse & {
  aborted: boolean;
  encrypted: boolean;
};

export function decorateHttpResponse(res: HttpResponse): HttpResponseDecorated {
  const resDecorated: HttpResponseDecorated = res as any;
  resDecorated.aborted = false;
  resDecorated.encrypted = false;

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
    console.log('uWsToRequest: onAbort triggered', 'res.aboorted', res.aborted);
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
    // FIXME: dont forget to set res.encrypted!
    const protocol = res.encrypted ? 'https:' : 'http:';

    // TODO: reuse already parsed headers?
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
      // console.log('ReadableStream: start');
      const onData = (ab: ArrayBuffer, isLast: boolean) => {
        // special case of empty body
        if (size == 0 && ab.byteLength == 0 && isLast) {
          // console.log('ReadableStream: empty body optimization');
          onEnd();
          return;
        }

        // console.log(
        //   'ReadableStream: onData',
        //   'ab',
        //   ab,
        //   'isLast',
        //   isLast,
        //   'hasClosed',
        //   hasClosed,
        //   'aborted',
        //   res.aborted
        // );
        size += ab.byteLength;
        if (!opts.maxBodySize || size <= opts.maxBodySize) {
          // console.log(
          //   'ReadableStream: enqueue',
          //   'ab',
          //   ab,
          //   'size',
          //   size,
          //   'hasClosed',
          //   hasClosed,
          //   'aborted',
          //   res.aborted
          // );
          controller.enqueue(new Uint8Array(ab));

          // TODO: double and tripple check this
          if (isLast) {
            onEnd();
          }

          return;
        }
        // console.log('ReadableStream: error', 'payload too large');

        controller.error(
          new TRPCError({
            code: 'PAYLOAD_TOO_LARGE',
          })
        );
        hasClosed = true;
      };

      const onEnd = () => {
        // console.log(
        //   'ReadableStream: onEnd',
        //   'hasClosed',
        //   hasClosed,
        //   'aborted',
        //   res.aborted!
        // );

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
      // console.log(
      //   'ReadableStream: cancel',
      //   'hasClosed',
      //   hasClosed,
      //   'aborted',
      //   res.aborted!
      // );

      res.close();
    },
  });
}

export async function uWsSendResponse(
  res: HttpResponseDecorated,
  fetchRes: Response
): Promise<void> {
  // TODO: stream response instead
  // use writeResponseBody from packages/server/src/adapters/node-http/writeResponse.ts
  // and https://github.com/uNetworking/uWebSockets.js/blob/master/examples/VideoStreamer.js
  const unsteamed_text = await fetchRes.text();

  console.log('unsteamed_text', unsteamed_text);

  // TODO: is this sifficient?
  if (res.aborted) return;

  res.cork(() => {
    res.writeStatus(fetchRes.status.toString());
    // res.writeStatus(fetchRes.statusText); // <-- for some reason this is left empty at times...

    fetchRes.headers.forEach((value, key) => {
      res.writeHeader(key, value);
    });
    // this is not needed, as forEach iterates over everything nicely
    // doublecheck set-cookie though https://developer.mozilla.org/en-US/docs/Web/API/Headers/getSetCookie
    // fetchRes.headers.getSetCookie().forEach((value) => {
    //   res.writeHeader('set-cookie', value);
    // });

    res.end(unsteamed_text);
  });
}

// TODO: use the tryEnd instead to deal with potential backpressure
export async function uWsSendResponseStreamed(
  res: HttpResponseDecorated,
  fetchRes: Response
): Promise<void> {
  // TODO: is this sifficient?
  if (res.aborted) return;

  res.onAborted(() => {
    console.log(
      'uWsSendResponseStreamed: onAbort triggered',
      'res.aboorted status already',
      res.aborted
    );
    res.aborted = true;
  });

  res.cork(() => {
    res.writeStatus(fetchRes.status.toString());
    // res.writeStatus(fetchRes.statusText); // <-- for some reason this is left empty at times...

    fetchRes.headers.forEach((value, key) => {
      console.log('uWsSendResponseStreamed: writing header', key, '=', value);
      res.writeHeader(key, value);
    });
  });

  // https://stackoverflow.com/questions/62121310/how-to-handle-streaming-data-using-fetch
  if (fetchRes.body) {
    const reader = fetchRes.body.getReader();

    // these are for debugging purposes
    let chunkCount = 0;
    let totalSent = 0;

    while (true) {
      const { value, done } = await reader.read();

      console.log(
        'uWsSendResponseStreamed: got chunk with value',
        value,
        'done',
        done
      );
      if (done) {
        console.log(
          'uWsSendResponseStreamed: finished sending',
          value,
          'done',
          done
        );
        if (!res.aborted) {
          res.end();
        }
        return;
      }
      // FIXME: this is actually very wasteful to send many small streamed respones
      // should they be grouped to some larger buffer/timeout?
      if (res.aborted) {
        console.log(
          'uWsSendResponseStreamed: abort before corking response',
          value,
          'done',
          done
        );
        return;
      }
      res.cork(() => {
        chunkCount++;
        const noBackPressure = res.write(value);
        totalSent += value.byteLength;
        if (!noBackPressure) {
          console.error(
            'uWsSendResponseStreamed: BACKPRESSURE DETECTED',
            'chunkCount',
            chunkCount,
            'totalSentWithoutBackpressure',
            totalSent,
            'thisChunkLen',
            value.byteLength
          );
        }
      });
    }
  } else {
    res.end();
    return;
  }
}

// using
// packages/server/src/adapters/node-http/writeResponse.ts
export async function uWsSendResponseStreamed2(
  fetchReq: Request, // this is needed for the abort signal
  fetchRes: Response,
  res: HttpResponseDecorated
): Promise<void> {
  // TODO: is this sifficient?
  if (res.aborted) return;

  res.onAborted(() => {
    console.log(
      'uWsSendResponseStreamed2: onAbort triggered',
      'res.aboorted status already',
      res.aborted
    );
    res.aborted = true;
  });

  res.cork(() => {
    res.writeStatus(fetchRes.status.toString());
    // res.writeStatus(fetchRes.statusText); // <-- for some reason this is left empty at times...

    fetchRes.headers.forEach((value, key) => {
      res.writeHeader(key, value);
    });
  });

  // https://stackoverflow.com/questions/62121310/how-to-handle-streaming-data-using-fetch
  if (fetchRes.body) {
    // these are for debugging purposes
    let chunkCount = 0;
    let totalSent = 0;

    try {
      const writeableStream = new WritableStream({
        // TODO check types
        async write(chunk: Uint8Array) {
          console.log(
            'uWsSendResponseStreamed2: got chunk with value',
            chunk,
            'len',
            chunk.length
          );

          if (res.aborted) {
            console.error(
              'uWsSendResponseStreamed2: aborted before writing chunk'
            );
            return;
          }

          res.cork(() => {
            chunkCount++;
            const noBackPressure = res.write(chunk);
            totalSent += chunk.byteLength;
            if (!noBackPressure) {
              console.error(
                'uWsSendResponseStreamed2: BACKPRESSURE DETECTED',
                'chunkCount',
                chunkCount,
                'totalSentWithoutBackpressure',
                totalSent,
                'thisChunkLen',
                chunk.byteLength
              );
            }
          });
        },
      });

      await fetchRes.body.pipeTo(writeableStream, {
        signal: fetchReq.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        console.error('uWsSendResponseStreamed2: abort error encountered'); // so that eslint donest complain

        return;
      }
      console.error('uWsSendResponseStreamed2: streamed response 2 error', err); // so that eslint donest complain
      throw err;
    } finally {
      if (!res.aborted) {
        res.end();
      } else {
        console.error('uWsSendResponseStreamed2: aborted before writing chunk');
      }
    }
  } else {
    res.end();
  }
}
