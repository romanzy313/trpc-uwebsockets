# trpc-uwebsockets

[uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) adapter for [tRPC](https://trpc.io/)

# Installation

```bash
yarn add trpc-uwebsockets
```

# Usage

Import needed packages

```typescript
import { App } from 'uWebSockets.js';
import * as trpc from '@trpc/server';
import z from 'zod';
```

Define tRPC context and router

```typescript
type Context = {
  user: {
    name: string;
  } | null;
};

const createContext = (opts: UWebSocketsContextOptions): Context => {
  const getUser = () => {
    if (opts?.req.headers.authorization) {
      // const user = await decodeJwtToken(req.headers.authorization.split(' ')[1])
      // return user;
    }
    return null;
  };

  return {
    user: getUser(),
  };
};

const router = trpc.router<Context>().query('hello', {
  input: z
    .object({
      who: z.string().nullish(),
    })
    .nullish(),
  resolve({ input, ctx }) {
    return {
      text: `hello ${input?.who ?? ctx.user?.name ?? 'world'}`,
    };
  },
});
```

Initialize uWebsockets server and attach tRPC router

```typescript
const app = App();

createUWebSocketsHandler(app, '/trpc', {
  router,
  createContext,
});

/* dont crash on unknown request */
app.any('/*', (res) => {
  res.writeStatus('404 NOT FOUND');
  res.end();
});

app.listen('0.0.0.0', 8000, () => {
  console.log('Server listening on http://localhost:8000');
});
```

# API

Create uWebSockets handler options

```typescript
function createUWebSocketsHandler<TRouter extends AnyRouter>(
  /* instance of the uWebSockets server */
  uWsApp: TemplatedApp,
  /* Path to trpc without trailing slash (ex: "/trpc") */
  pathPrefix: string,
  /* Handler options */
  opts: UWebSocketsCreateHandlerOptions<TRouter>
);
```

Handler options

```typescript
type UWebSocketsCreateHandlerOptions<TRouter extends AnyRouter> = {
  /* trpc router */
  router: TRouter;
  /* optional create context */
  createContext?: (
    opts: UWebSocketsCreateContextOptions
  ) => Promise<inferRouterContext<TRouter>> | inferRouterContext<TRouter>;
  /* optional pre-request handler. Useful for dealing with CORS, or sending extra headers */
  onRequest?: (
    req: UWebSocketsRequestObject,
    res: UWebSocketsResponseObject
  ) => void;
};
```

Create context options

```typescript
type UWebSocketsCreateContextOptions = {
  /* read-only request information */
  req: {
    headers: Record<string, string>;
    method: 'POST' | 'GET';
    query: URLSearchParams;
    path: string;
    getCookies: (opts?: CookieParseOptions) => Record<string, string>;
  };
  /* minimal response interface */
  res: {
    setStatus(status: number): void;
    setHeader(key: string, value: string): void;
    setCookie(key: string, value: string, opts?: CookieSerializeOptions): void;
  };
  /* instance of the uWebSockets server */
  uWs: TemplatedApp;
};
```

# Testing

```bash
yarn t
```

or

```bash
yarn test:watch
```

# Todo

- [ ] Native subscription support
- [ ] Expose batching options (after v10)
- [ ] Implement onError handling (after v10)
