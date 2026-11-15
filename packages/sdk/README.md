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

## Resumable uploads

`startResumableUpload` sends a file through the server's resumable upload resources (`/assets/uploads`). A dropped connection, a restart or a closed laptop picks up from the bytes the server already holds. You supply the file's size, its SHA-256 as hex and a `readChunk(offset, length)` function, so it works with a browser `Blob` and with a Node file handle.

```typescript
import { open } from "node:fs/promises";
import { getUploadLimits, isResumableUploadError, resumeResumableUpload, startResumableUpload } from "@frameleaf/sdk";

const options = { baseUrl: "https://photos.example.com/api", headers: { "x-api-key": API_KEY } };

// null: the server is older and only takes multipart POST /assets.
const limits = await getUploadLimits(options);

const handle = await open(path);
const input = {
  ...options,
  size,
  sha256, // 64 hex characters
  contentType: "image/jpeg",
  metadata: { filename: "IMG_0001.jpg", fileCreatedAt, fileModifiedAt },
  readChunk: async (offset: number, length: number) => {
    const buffer = new Uint8Array(length);
    await handle.read(buffer, 0, length, offset);
    return buffer;
  },
  onResource: (url: string) => saveForLater(url), // before any bytes go
  onProgress: (committed: number) => console.log(committed), // bytes the server confirmed
};

try {
  const { id, status } = await startResumableUpload(input);
  // after a crash: await resumeResumableUpload(savedUrl, input)
} catch (error) {
  if (isResumableUploadError(error, "deleted_by_owner")) {
    // the account deleted this item and asked not to have it uploaded again
  }
}
```

In a browser, read with `new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())`. An `AbortSignal` in `signal` stops the upload and leaves it resumable. `cancelResumableUpload(url, options)` discards an unfinished one.
