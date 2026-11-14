import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ConnectApi,
  ConnectError,
  discover,
  exchange,
  libraryOrigin,
  RAYCAST_REDIRECT,
  register,
  revoke,
  saveNew,
  withLock,
  type Fetch,
} from "../src/lib/connect.ts";

const ORIGIN = "https://photos.example.com";

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as Fetch;
  return { impl, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const kind = (k: string) => (error: unknown) => error instanceof ConnectError && error.kind === k;

const metadata = (overrides: Record<string, unknown> = {}) => ({
  issuer: ORIGIN,
  authorization_endpoint: `${ORIGIN}/api/oauth/apps/authorize`,
  token_endpoint: `${ORIGIN}/api/oauth/apps/token`,
  revocation_endpoint: `${ORIGIN}/api/oauth/apps/revoke`,
  registration_endpoint: `${ORIGIN}/api/oauth/apps/register`,
  code_challenge_methods_supported: ["S256"],
  ...overrides,
});
const resource = (overrides: Record<string, unknown> = {}) => ({
  resource: `${ORIGIN}/api/connect`,
  authorization_servers: [ORIGIN],
  scopes_supported: ["library:read", "library:download"],
  ...overrides,
});
const discovery = (server: object = metadata(), protectedResource: object = resource()) =>
  fakeFetch((url) =>
    url.endsWith("/.well-known/oauth-protected-resource/api/connect") ? json(protectedResource) : json(server),
  );

test("library address must be HTTPS, or HTTP on a private network", () => {
  assert.equal(libraryOrigin(" https://photos.example.com/ "), ORIGIN);
  assert.equal(libraryOrigin("http://127.0.0.1:2283"), "http://127.0.0.1:2283");
  assert.equal(libraryOrigin("http://192.168.1.10:2283"), "http://192.168.1.10:2283");
  assert.equal(libraryOrigin("http://nas.local:2283/"), "http://nas.local:2283");
  for (const bad of [
    undefined,
    "",
    "photos.example.com",
    "http://photos.example.com",
    "http://8.8.8.8",
    "http://172.32.0.1",
    "https://user:pw@photos.example.com",
    "https://photos.example.com/albums",
    "https://photos.example.com/?x=1",
    "https://photos.example.com/#x",
  ]) {
    assert.throws(() => libraryOrigin(bad), kind("address"), String(bad));
  }
});

test("discovery is pinned to the configured origin", async () => {
  const endpoints = await discover(discovery().impl, ORIGIN);
  assert.deepEqual(endpoints, {
    resource: `${ORIGIN}/api/connect`,
    authorize: `${ORIGIN}/api/oauth/apps/authorize`,
    token: `${ORIGIN}/api/oauth/apps/token`,
    revoke: `${ORIGIN}/api/oauth/apps/revoke`,
    register: `${ORIGIN}/api/oauth/apps/register`,
  });

  const { register: absent } = await discover(discovery(metadata({ registration_endpoint: undefined })).impl, ORIGIN);
  assert.equal(absent, undefined);

  for (const [server, protectedResource] of [
    [metadata({ issuer: "https://evil.example" }), resource()],
    [metadata({ token_endpoint: "https://evil.example/token" }), resource()],
    [metadata({ code_challenge_methods_supported: ["plain"] }), resource()],
    [metadata(), resource({ resource: `${ORIGIN}/api` })],
    [metadata(), resource({ authorization_servers: ["https://evil.example"] })],
  ] as [object, object][]) {
    await assert.rejects(discover(discovery(server, protectedResource).impl, ORIGIN), kind("metadata"));
  }
  const offline = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
  await assert.rejects(discover(offline.impl, ORIGIN), kind("offline"));
  assert.equal(offline.calls[0].init.redirect, "error");
});

test("registration asks for Raycast's exact web redirect", async () => {
  const endpoints = await discover(discovery().impl, ORIGIN);
  const { impl, calls } = fakeFetch(() => json({ client_id: "client-1" }, 201));
  assert.equal(await register(impl, endpoints), "client-1");
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.redirect_uris, [RAYCAST_REDIRECT]);
  assert.equal(body.token_endpoint_auth_method, "none");
  assert.equal(body.scope, "library:read library:download");

  await assert.rejects(register(impl, { ...endpoints, register: undefined }), kind("registration"));
  await assert.rejects(register(fakeFetch(() => json({ error: "x" }, 403)).impl, endpoints), kind("registration"));
});

test("token responses are validated and carry the resource", async () => {
  const endpoints = await discover(discovery().impl, ORIGIN);
  const good = { token_type: "Bearer", access_token: "a", refresh_token: "r", expires_in: 3600, scope: "library:read" };
  const { impl, calls } = fakeFetch(() => json(good));
  assert.deepEqual(await exchange(impl, endpoints, { grant_type: "refresh_token", refresh_token: "old" }), {
    accessToken: "a",
    refreshToken: "r",
    expiresIn: 3600,
    scope: "library:read",
  });
  assert.equal(new URLSearchParams(String(calls[0].init.body)).get("resource"), `${ORIGIN}/api/connect`);

  assert.deepEqual(await exchange(fakeFetch(() => json({ error: "invalid_grant" }, 400)).impl, endpoints, {}), {
    error: "invalid_grant",
  });
  for (const bad of [
    { ...good, refresh_token: "" },
    { ...good, token_type: "mac" },
    { ...good, expires_in: 0 },
    { ...good, scope: "library:download" },
    { ...good, scope: "library:read albums:write" },
  ]) {
    await assert.rejects(exchange(fakeFetch(() => json(bad)).impl, endpoints, {}), kind("server"));
  }
  await assert.rejects(exchange(fakeFetch(() => json({}, 503)).impl, endpoints, {}), kind("busy"));
});

test("revocation sends the token with its client", async () => {
  const { impl, calls } = fakeFetch(() => json({}));
  await revoke(impl, `${ORIGIN}/api/oauth/apps/revoke`, "client-1", "refresh-1");
  const body = new URLSearchParams(String(calls[0].init.body));
  assert.equal(body.get("token"), "refresh-1");
  assert.equal(body.get("client_id"), "client-1");
});

test("API sends bearer tokens, refreshes once on 401 and reports a revoked grant", async () => {
  const tokens: (string | undefined)[] = [];
  const source = async (rejected?: string) => {
    tokens.push(rejected);
    return rejected ? "second" : "first";
  };
  let status = 401;
  const { impl, calls } = fakeFetch((_url, init) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    return auth === "Bearer second" && status === 200
      ? json({ items: [], total: 0, page: 1, size: 50 })
      : json({}, 401);
  });
  const api = new ConnectApi(ORIGIN, source, impl);
  await assert.rejects(api.assets({ q: "beach" }), kind("revoked"));
  assert.deepEqual(tokens, [undefined, "first"]);

  status = 200;
  tokens.length = 0;
  calls.length = 0;
  await api.assets({ q: "beach", albumId: undefined, page: 2, size: 50 });
  assert.equal(calls.at(-1)?.url, `${ORIGIN}/api/connect/assets?q=beach&page=2&size=50`);
});

test("API maps statuses to distinguishable errors and hides unreadable albums", async () => {
  for (const [status, expected] of [
    [403, "forbidden"],
    [404, "missing"],
    [409, "busy"],
    [500, "server"],
  ] as const) {
    const api = new ConnectApi(ORIGIN, async () => "t", fakeFetch(() => json({}, status)).impl);
    await assert.rejects(api.capabilities(), kind(expected));
  }
  const albums = new ConnectApi(
    ORIGIN,
    async () => "t",
    fakeFetch(() =>
      json({
        items: [
          { id: "1", name: "Read", workspace: "photo", canRead: true, canWrite: false },
          { id: "2", name: "Write only", workspace: "photo", canRead: false, canWrite: true },
        ],
      }),
    ).impl,
  );
  assert.deepEqual(
    (await albums.albums()).map((album) => album.name),
    ["Read"],
  );
});

test("renditions return bytes with their media type", async () => {
  const { impl, calls } = fakeFetch(
    () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg; charset=binary" } }),
  );
  const api = new ConnectApi(ORIGIN, async () => "t", impl);
  const result = await api.rendition("abc", "display");
  assert.deepEqual([...result.bytes], [1, 2, 3]);
  assert.equal(result.type, "image/jpeg");
  assert.equal(calls[0].url, `${ORIGIN}/api/connect/assets/abc/rendition?variant=display`);
});

test("only one refresh runs at a time across callers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frameleaf-raycast-"));
  try {
    let active = 0;
    let peak = 0;
    const work = () =>
      withLock(dir, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
      });
    await Promise.all([work(), work(), work()]);
    assert.equal(peak, 1);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloads never overwrite and never use original filenames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frameleaf-raycast-"));
  try {
    const asset = { id: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", createdAt: "2026-07-04T12:00:00.000Z" };
    const first = await saveNew(dir, asset, "image/jpeg", new Uint8Array([1]));
    const second = await saveNew(dir, asset, "image/jpeg", new Uint8Array([2]));
    const original = await saveNew(dir, asset, "image/heic", new Uint8Array([3]), " original");
    assert.equal(first, join(dir, "Frameleaf 2026-07-04 0f1e2d3c.jpg"));
    assert.equal(second, join(dir, "Frameleaf 2026-07-04 0f1e2d3c (2).jpg"));
    assert.equal(original, join(dir, "Frameleaf 2026-07-04 0f1e2d3c original.heic"));
    assert.deepEqual([...(await readFile(first))], [1]);
    assert.equal((await readdir(dir)).length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
