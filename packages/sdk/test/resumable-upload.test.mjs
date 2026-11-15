import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  cancelResumableUpload,
  encodeAssetMetadata,
  getUploadLimits,
  isResumableUploadError,
  reprDigest,
  resumeResumableUpload,
  ResumableUploadError,
  startResumableUpload,
} from "../build/index.js";

const ID = "6f1f8c0e-2d1b-4c55-9a77-0f6f0d9f3b21";
const BASE = "https://photos.example.test/api";
const URL_ = `${BASE}/assets/uploads/${ID}`;
const CHUNK = 4;
const file = Uint8Array.from({ length: 20 }, (_, index) => index);
const sha256 = createHash("sha256").update(file).digest("hex");
const metadata = {
  filename: "IMG_0001.jpg",
  fileCreatedAt: "2026-11-15T00:00:00.000Z",
  fileModifiedAt: "2026-11-15T00:00:00.000Z",
};
const done = { id: "a3c8f0c2-3b7a-4f0e-8d6c-6e2f1d0b9a11", status: "created", sha256 };

/** A server holding one upload resource, with hooks to break it the way networks do. */
const server = (hooks = {}) => {
  const state = { offset: 0, created: 0, appends: [], heads: 0, results: 0 };
  const limit = `max-size=1000, max-append-size=${CHUNK}, max-age=86400, min-size=1`;
  const fetch = async (url, init) => {
    init.signal?.throwIfAborted();
    const method = init.method;
    const headers = init.headers;
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Upload-Limit": limit, "Upload-Parts": "max-parallel=4" } });
    }
    if (method === "POST") {
      state.created++;
      assert.equal(headers["Repr-Digest"], reprDigest(sha256));
      assert.equal(headers["Upload-Length"], String(file.length));
      assert.equal(headers["Content-Type"], "image/jpeg");
      if (hooks.create) return hooks.create();
      return new Response(null, {
        status: 201,
        headers: { Location: `/api/assets/uploads/${ID}`, "Upload-Limit": limit },
      });
    }
    assert.ok(url.startsWith(URL_), url);
    if (method === "HEAD") {
      state.heads++;
      return new Response(null, { status: 204, headers: { "Upload-Offset": String(state.offset), "Upload-Limit": limit } });
    }
    if (method === "PATCH") {
      const offset = Number(headers["Upload-Offset"]);
      if (offset !== state.offset) {
        return Response.json({ message: "Upload offset does not match" }, { status: 409 });
      }
      const hooked = await hooks.patch?.(offset, state);
      if (hooked) return hooked;
      state.appends.push(offset);
      state.offset += init.body.byteLength;
      const complete = headers["Upload-Complete"] === "?1";
      if (complete && hooks.lastResponseLost) {
        throw new TypeError("fetch failed");
      }
      if (complete) return Response.json(done);
      return new Response(null, { status: 204, headers: { "Upload-Offset": String(state.offset) } });
    }
    if (method === "GET" && url.endsWith("/result")) {
      state.results++;
      return state.offset === file.length ? Response.json(done) : new Response(null, { status: 202 });
    }
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetch, state };
};

const input = (fetch, extra = {}) => ({
  baseUrl: BASE,
  fetch,
  size: file.length,
  sha256,
  contentType: "image/jpeg",
  metadata,
  chunkSize: 64,
  backoffMs: 1,
  readChunk: async (offset, length) => file.slice(offset, offset + length),
  ...extra,
});

test("reads the server's limits, and null for a server without resumable uploads", async () => {
  assert.deepEqual(await getUploadLimits({ baseUrl: BASE, fetch: server().fetch }), {
    maxSize: 1000,
    maxAppendSize: CHUNK,
    maxAge: 86_400,
    maxParallel: 4,
  });
  const old = async () => new Response(null, { status: 404 });
  assert.equal(await getUploadLimits({ baseUrl: BASE, fetch: old }), null);
});

test("sends the file in the server's append size and reports committed bytes", async () => {
  const { fetch, state } = server();
  const progress = [];
  let resource;
  const result = await startResumableUpload(
    input(fetch, { onResource: (url) => (resource = url), onProgress: (committed) => progress.push(committed) }),
  );
  assert.deepEqual(result, done);
  assert.equal(resource, URL_);
  assert.deepEqual(state.appends, [0, 4, 8, 12, 16]);
  assert.deepEqual(progress.at(-1), file.length);
});

test("interrupted after 3 of 5 chunks, a resume sends only chunks 4 and 5", async () => {
  const controller = new AbortController();
  const first = server({
    patch: (offset) => {
      if (offset === 12 && !controller.signal.aborted) {
        controller.abort();
        throw controller.signal.reason;
      }
    },
  });
  await assert.rejects(
    startResumableUpload(input(first.fetch, { signal: controller.signal })),
    (error) => error.name === "AbortError",
  );
  assert.deepEqual(first.state.appends, [0, 4, 8]);

  // The same server, a new run: only what the server doesn't hold goes.
  first.state.appends = [];
  const result = await resumeResumableUpload(URL_, input(first.fetch));
  assert.deepEqual(result, done);
  assert.deepEqual(first.state.appends, [12, 16]);
  assert.equal(first.state.created, 1);
});

test("a dropped connection resumes from the server's offset without re-sending held bytes", async () => {
  let dropped = false;
  const { fetch, state } = server({
    patch: (offset) => {
      if (offset === 8 && !dropped) {
        dropped = true;
        throw new TypeError("fetch failed");
      }
    },
  });
  assert.deepEqual(await startResumableUpload(input(fetch)), done);
  assert.deepEqual(state.appends, [0, 4, 8, 12, 16]);
  assert.ok(state.heads >= 1);
});

test("a lost final response recovers the result without uploading again", async () => {
  const { fetch, state } = server({ lastResponseLost: true });
  assert.deepEqual(await startResumableUpload(input(fetch)), done);
  assert.deepEqual(state.appends, [0, 4, 8, 12, 16]);
  assert.equal(state.results, 1);
});

test("an offset conflict carries on from the offset the server holds", async () => {
  const { fetch, state } = server();
  state.offset = 8; // an earlier run's bytes the client didn't know about
  assert.deepEqual(await resumeResumableUpload(URL_, input(fetch)), done);
  assert.deepEqual(state.appends, [8, 12, 16]);
});

test("refusals are typed: deleted by the owner, claimed by iCloud sync, gone", async () => {
  for (const reason of ["deleted_by_owner", "icloud_claimed"]) {
    const { fetch } = server({ create: () => Response.json({ message: reason, statusCode: 409 }, { status: 409 }) });
    await assert.rejects(startResumableUpload(input(fetch)), (error) => {
      assert.ok(error instanceof ResumableUploadError);
      assert.ok(isResumableUploadError(error, reason));
      assert.equal(error.status, 409);
      return true;
    });
  }
  const gone = async () => Response.json({ message: "Upload unavailable" }, { status: 404 });
  await assert.rejects(resumeResumableUpload(URL_, input(gone)), (error) => isResumableUploadError(error, "unavailable"));
});

test("an identical file the server already has finishes on create", async () => {
  const { fetch, state } = server({ create: () => Response.json({ ...done, status: "duplicate" }) });
  assert.equal((await startResumableUpload(input(fetch))).status, "duplicate");
  assert.deepEqual(state.appends, []);
});

test("cancel treats an upload that's already gone as cancelled", async () => {
  await cancelResumableUpload(URL_, { baseUrl: BASE, fetch: server().fetch });
  await cancelResumableUpload(URL_, { baseUrl: BASE, fetch: async () => new Response(null, { status: 404 }) });
});

test("headers are the server's canonical forms", () => {
  const encoded = encodeAssetMetadata({ ...metadata, filename: "été.jpg" });
  assert.match(encoded, /^[\w-]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")).filename, "été.jpg");
  assert.equal(reprDigest(sha256), `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`);
  assert.throws(() => reprDigest("abc"), TypeError);
});
