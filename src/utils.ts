import { TRPCError } from '@trpc/server';
import { HttpResponse } from 'uWebSockets.js';
import cookie, { CookieParseOptions } from 'cookie';
/*
cookie: 'cookie1=abc; cookie2=d.e'
*/

export const getCookieFn =
  (headers: Record<string, string>) => (opts?: CookieParseOptions) => {
    if (!('cookie' in headers)) return {};

    return cookie.parse(headers.cookie, opts);
  };

export function readPostBody(method: string, res: HttpResponse) {
  return new Promise<
    { ok: true; data: unknown } | { ok: false; error: TRPCError }
  >((resolve) => {
    if (method == 'GET') {
      // no body in get request
      resolve({
        ok: true,
        data: undefined,
      });
    }

    let buffer: Buffer;
    res.onData((ab, isLast) => {
      const chunk = Buffer.from(ab);

      if (isLast) {
        if (buffer) {
          // large request, with multiple chunks
          resolve({
            ok: true,
            data: buffer.toString(), // do i need utf8?
          });
        } else {
          // only a single chunk was recieved
          resolve({
            ok: true,
            data: chunk.toString(),
          });
        }
      } else {
        if (buffer) {
          buffer = Buffer.concat([buffer, chunk]);
        } else {
          buffer = Buffer.concat([chunk]);
        }
      }
    });

    res.onAborted(() => {
      resolve({
        ok: false,
        error: new TRPCError({ code: 'CLIENT_CLOSED_REQUEST' }),
      });
    });
  });
}
