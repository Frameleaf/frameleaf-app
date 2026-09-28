# @immich/sdk

A TypeScript SDK for interfacing with the Frameleaf API.

## Install

```bash
npm i --save @immich/sdk
```

## Usage

For a more detailed example, check out the [`@immich/cli`](../cli).

```typescript
import { getAllAlbums, getMyUser, init } from "@immich/sdk";

const API_KEY = "<API_KEY>"; // process.env.IMMICH_API_KEY

init({ baseUrl: "https://photos.example.com/api", apiKey: API_KEY });

const user = await getMyUser();
const albums = await getAllAlbums({});

console.log({ user, albums });
```
