# @frameleaf/sdk

A TypeScript SDK for interfacing with the Frameleaf API.

## Build the workspace package

The SDK is local to this repository. Consumers declare `"@frameleaf/sdk": "workspace:*"`; no published Immich package is required. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @frameleaf/sdk build
```

## Usage

For a more detailed example, check out the [`@frameleaf/cli`](../cli).

```typescript
import { getAllAlbums, getMyUser, init } from "@frameleaf/sdk";

const API_KEY = "<API_KEY>"; // process.env.FRAMELEAF_API_KEY

init({ baseUrl: "https://photos.example.com/api", apiKey: API_KEY });

const user = await getMyUser();
const albums = await getAllAlbums({});

console.log({ user, albums });
```
