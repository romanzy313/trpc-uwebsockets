# trpc-uwebsockets

[uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) adapter for [tRPC](https://trpc.io/)

# Installation

Version 10

```bash
npm install trpc-uwebsockets
```

Version 11 beta

```bash
npm install trpc-uwebsockets@beta
```

# Usage

Import needed packages

```typescript
import { App } from 'uWebSockets.js';
import { inferAsyncReturnType, initTRPC } from '@trpc/server';
import { CreateContextOptions } from 'trpc-uwebsockets';
import z from 'zod';
```

Define tRPC, context, and router

```typescript
const t = initTRPC.context<Context>().create();

const createContext = ({ req, res }: CreateContextOptions) => {
  const getUser = () => {
    if (req.headers.authorization === 'meow') {
      return {
        name: 'KATT',
      };
    }
    return null;
  };
  return {
    req,
    res,
    user: getUser(),
  };
};
export type Context = inferAsyncReturnType<typeof createContext>;

const router = t.router({
  hello: t.procedure
    .input(
      z
        .object({
          who: z.string().nullish(),
        })
        .nullish()
    )
    .query(({ input, ctx }) => {
      return {
        text: `hello ${input?.who ?? ctx.user?.name ?? 'world'}`,
      };
    }),
});
```

Initialize uWebsockets server and attach tRPC

```typescript
const app = App();

/* handle CORS as needed */
app.options('/*', (res) => {
  res.writeHeader('Access-Control-Allow-Origin', allowOrigin);
  res.endWithoutBody();
});

createUWebSocketsHandler(app, '/trpc', {
  router,
  createContext,
  // CORS part 2. See https://trpc.io/docs/server/caching for more information
  responseMeta({ ctx, paths, type, errors }) {
    return {
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
    };
  },
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

Create context options

```typescript
type CreateContextOptions = {
  /* read-only request information */
  req: {
    headers: Record<string, string>;
    method: 'POST' | 'GET';
    query: URLSearchParams;
    path: string;
  };
  /* see https://unetworking.github.io/uWebSockets.js/generated/interfaces/HttpResponse.html */
  res: {
    writeStatus(status: RecognizedString): HttpResponse;
    writeHeader(key: RecognizedString, value: RecognizedString): HttpResponse;
  };
};
```

# Enabling subscrptions

Simple method: enable subscriptions when creating the main handler.

```typescript
createUWebSocketsHandler(app, '/trpc', {
  router,
  createContext,
  enableSubscriptions: true,
});
```

Recommended method: enable subscriptions after registering main request handler.

<!-- For example, cookies are not accessible inside WSHandler createContext, so in order to implement auth query string param with jwt needs to be implemented. -->

```typescript
const app = App();

createUWebSocketsHandler(app, '/trpc', {
  router,
  createContext: ({ req, res }) => {},
});

applyWSHandler(app, '/trpc', {
  router,
  createContext: ({ req, res }) => {},
});
```

## example of subscrption client

```typescript
import {
  createTRPCProxyClient,
  createWSClient,
  httpBatchLink,
  splitLink,
  wsLink,
} from '@trpc/client';

const host = `localhost:8080/trpc`;
const wsClient = createWSClient({ url: `ws://${host}` });
const client = createTRPCProxyClient<AppRouter>({
  links: [
    splitLink({
      condition(op) {
        return op.type === 'subscription';
      },
      true: wsLink({ client: wsClient }),
      false: httpBatchLink({
        url: `http://${host}`,
        headers: headers,
      }),
    }),
  ],
});
```
