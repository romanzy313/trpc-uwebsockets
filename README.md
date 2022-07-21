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
```

Define tRPC context and router

```typescript
type Context = {
  user: {
    name: string;
  } | null;
};

const createContext: any = (opts: UWebSocketsContextOptions): Context => {
  const getUser = () => {
    if (opts.req.headers.authorization === 'meow') {
      return {
        name: 'KATT',
      };
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

Initialize uWebsockets server and attach tTRP router

```typescript
const app = App();

createUWebSocketsHandler(app, '/trpc', {
  router,
  createContext,
});

app.listen('0.0.0.0', 8000, () => {
  console.log('server listening on http://localhost:8000');
});
```

# Testing

```bash
yarn t
```

or

```bash
yarn test:watch
```
