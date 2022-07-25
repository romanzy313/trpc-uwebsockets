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
      //resolve right away if there is only one chunk
      if (buffer === undefined && isLast) {
        resolve({
          ok: true,
          data: Buffer.from(ab).toString(),
        });
        return;
      }

      const chunk = Buffer.from(ab);

      //else accumulate
      if (buffer) buffer = Buffer.concat([buffer, chunk]);
      else buffer = Buffer.concat([chunk]);

      if (isLast) {
        resolve({
          ok: true,
          data: buffer.toString(),
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
}
