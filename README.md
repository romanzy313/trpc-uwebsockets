# trpc-uwebsockets

[uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) adapter for [tRPC](https://trpc.io/)

# Installation

To use old, stable version 9

```bash
yarn add trpc-uwebsockets@^0.9.*
```

To use version 10 beta run

```bash
yarn add trpc-uwebsockets
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

Create context options

```typescript
type CreateContextOptions = {
  /* read-only request information */
  req: {
    headers: Record<string, string>;
    method: 'POST' | 'GET';
    query: string;
    path: string;
  };
  /* minimal response interface, useful for setting cookies */
  res: {
    setStatus(status: number): void;
    setHeader(name: string, value: string): void;
  };
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

- [ ] Various improvements (res.tryEnd + reading multiple headers /w same key)
- [ ] Subscription support with websockets
