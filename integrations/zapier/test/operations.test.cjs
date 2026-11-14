const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { test, afterEach, mock } = require("node:test");
const dns = require("node:dns/promises");
const nock = require("nock");
const core = require("zapier-platform-core");
const App = require("../index");
const run = core.createAppTester(App);
nock.disableNetConnect();
// Sources resolve to a public documentation address unless a test says otherwise.
mock.method(dns, "lookup", async (host) =>
  host === "rebind.example.net"
    ? [{ address: "169.254.169.254", family: 4 }]
    : [{ address: "203.0.113.10", family: 4 }],
);
afterEach(() => {
  assert.deepEqual(nock.pendingMocks(), []);
  nock.cleanAll();
});

const origin = "https://photos.example.org";
const source = "https://files.example.net";
const scope =
  "library:read library:download albums:write tags:write photos:upload boards:upload events:read";
const authData = {
  serverUrl: origin,
  frameleafClientId: "synthetic-client",
  frameleafBoundClientId: "synthetic-client",
  frameleafResource: origin + "/api/connect",
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope,
};
const connect = () =>
  nock(origin, {
    reqheaders: { authorization: "Bearer " + authData.access_token },
  });
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const albumId = id(900000);
const event = (n, type = "asset.ready") => ({
  event: type,
  deliveryId: id(n),
  occurredAt: "2026-01-01T00:00:00.000Z",
  subject: { kind: "asset", id: id(500000 + n), name: null },
  detail: type === "album.asset.added" ? { albumId } : {},
});
const method = (path) => path.split(".").reduce((value, key) => value[key], App);
const perform = (path, inputData = {}, meta = {}) =>
  run(method(path), { authData, inputData, meta });
const code = (error) => JSON.parse(error.message).code;

test("event trigger drains at most ten pages of the bounded feed, newest first, deduplicated", async () => {
  let pages = 0;
  connect()
    .get("/api/connect/events/latest")
    .query(true)
    .times(10)
    .reply((uri) => {
      const query = new URL(uri, origin).searchParams;
      assert.equal(query.get("type"), "asset.ready");
      assert.equal(query.get("cursor"), pages === 0 ? null : `c${pages}`);
      pages++;
      const start = (pages - 1) * 100;
      // A repeated delivery across pages must not produce a second record.
      const items = Array.from({ length: 100 }, (_, i) => event(start + i));
      if (pages > 1) items[0] = event(start - 1);
      return [200, { items, nextCursor: `c${pages}`, hasMore: true, bounded: true }];
    });
  const records = await perform("triggers.asset_ready.operation.perform");
  // An 11th page is never requested even though the Library says more exist: a flood beyond the
  // newest 1000 events between two polls is omitted by design, not synchronized.
  assert.equal(pages, 10);
  assert.equal(records.length, 991);
  assert.equal(new Set(records.map((r) => r.id)).size, records.length);
  assert.equal(records[0].id, id(0));
  assert.equal(records[0].assetId, id(500000));
  assert.match(records[0].file, /^hydrate\|\|\|/);
  assert.ok(!records[0].file.includes(authData.access_token));
});

test("album trigger filters by album, keeps cursor and filter together, and stops when the feed ends", async () => {
  connect()
    .get("/api/connect/events/latest")
    .query({ type: "album.asset.added", albumId })
    .reply(200, {
      items: [event(1, "album.asset.added"), event(2, "asset.ready")],
      nextCursor: "next",
      hasMore: true,
      bounded: true,
    });
  connect()
    .get("/api/connect/events/latest")
    .query({ type: "album.asset.added", albumId, cursor: "next" })
    .reply(200, { items: [event(3, "album.asset.added")], nextCursor: null, hasMore: false, bounded: true });
  const records = await perform("triggers.album_asset_added.operation.perform", {
    albumId,
    variant: "display",
  });
  assert.deepEqual(
    records.map((r) => [r.id, r.albumId]),
    [
      [id(1), albumId],
      [id(3), albumId],
    ],
  );
  assert.ok(records[0].file.includes("display"));
});

test("sample loading reads one event without touching a polling checkpoint", async () => {
  connect()
    .get("/api/connect/events/sample")
    .query({ type: "studio.export.completed" })
    .reply(200, {
      items: [{ ...event(7, "studio.export.completed"), detail: { format: "video/mp4" } }],
    });
  const records = await perform("triggers.studio_export_completed.operation.perform", {}, {
    isLoadingSample: true,
  });
  assert.equal(records[0].format, "video/mp4");
});

test("expired cursor, narrowed consent, busy hierarchy and expired token stay distinguishable", async () => {
  const cases = [
    [410, (e) => code(e) === "CursorExpired"],
    [403, (e) => code(e) === "Forbidden"],
    [429, (e) => e.name === "ThrottledError"],
    [401, (e) => e.name === "RefreshAuthError"],
  ];
  const conflicts = [
    ["Connect access is changing; retry the operation", (e) => e.name === "ThrottledError"],
    ["Connect operation unavailable", (e) => code(e) === "Unavailable"],
    ["Request ID payload changed", (e) => code(e) === "SourceIdReused"],
  ];
  for (const [message, check] of conflicts) {
    connect().get("/api/connect/events/latest").query(true).reply(409, { message });
    await assert.rejects(() => perform("triggers.asset_ready.operation.perform"), check);
  }
  for (const [status, check] of cases) {
    connect().get("/api/connect/events/latest").query(true).reply(status, {});
    await assert.rejects(() => perform("triggers.asset_ready.operation.perform"), check);
  }
});

test("a changed server binding refuses before any request carries the token", async () => {
  await assert.rejects(() =>
    run(method("triggers.asset_ready.operation.perform"), {
      authData: { ...authData, serverUrl: "https://other.example.org" },
      inputData: {},
      meta: {},
    }),
  );
});

const fakeZ = (response, stash) => ({
  errors: core.errors,
  request: async (options) => response(options),
  stashFile: stash,
});
const rendition = (status, headers) => ({
  status,
  headers: new Headers(headers),
});

test("deferred file hydration signs with the current token and bounds the rendition", async () => {
  let sent;
  const stashed = await App.hydrators.rendition(
    fakeZ(
      (options) => {
        sent = options;
        return rendition(200, { "content-length": "1234", "content-type": "image/jpeg" });
      },
      (response, length, name, type) => ({ length, name, type }),
    ),
    { authData: { ...authData, access_token: "rotated-access" }, inputData: { assetId: id(5), variant: "preview" } },
  );
  assert.equal(sent.url, `${origin}/api/connect/assets/${id(5)}/rendition`);
  assert.deepEqual(sent.params, { variant: "preview" });
  assert.equal(sent.headers.Authorization, "Bearer rotated-access");
  assert.equal(sent.redirect, "error");
  assert.deepEqual(stashed, { length: 1234, name: `${id(5)}.jpg`, type: "image/jpeg" });

  const stash = () => assert.fail("must not stash");
  for (const headers of [{}, { "content-length": String(101 * 1024 * 1024) }])
    await assert.rejects(() =>
      App.hydrators.rendition(fakeZ(() => rendition(200, headers), stash), {
        authData,
        inputData: { assetId: id(5), variant: "preview" },
      }),
    );
  await assert.rejects(
    () =>
      App.hydrators.rendition(fakeZ(() => rendition(404, {}), stash), {
        authData,
        inputData: { assetId: id(5), variant: "preview" },
      }),
    (e) => code(e) === "NotFound",
  );
  await assert.rejects(() =>
    App.hydrators.rendition(fakeZ(() => assert.fail("no request"), stash), {
      authData,
      inputData: { assetId: id(5), variant: "../original" },
    }),
  );
});

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(6, 1)]);
const capabilities = (overrides = {}) => ({
  albums: [{ id: albumId, name: "Inbox", workspace: "photo", canRead: true, canWrite: true }],
  limits: { maxUploadBytes: 1000, maxAppendBytes: 4 },
  supportedTypes: { upload: { photo: ["image/jpeg", "image/png", "video/mp4"], design: [] } },
  ...overrides,
});
const uploadId = id(800000);
const state = (offset, value = "receiving", receipt) => ({
  id: uploadId,
  offset,
  size: jpeg.length,
  state: value,
  expiresAt: "2026-01-02T00:00:00.000Z",
  ...(receipt && { receipt }),
});
const upload = { albumId, file: source + "/photo.jpeg", sourceId: "row-17", capturedAt: "2026-01-01T10:00:00Z" };

test("upload streams a bounded source without Library credentials, appends in chunks and commits", async () => {
  const sha = createHash("sha256").update(jpeg).digest("hex");
  const starts = [];
  nock(source, { badheaders: ["authorization"] }).get("/photo.jpeg").reply(200, jpeg);
  connect().get("/api/connect/capabilities").reply(200, capabilities());
  connect()
    .post("/api/connect/uploads", (body) => starts.push(body))
    .reply(201, state(0));
  const appended = [];
  connect()
    .patch(`/api/connect/uploads/${uploadId}`)
    .times(3)
    .reply(function (uri, body) {
      const offset = Number(this.req.headers["upload-offset"]);
      const chunk = Buffer.from(body, "hex");
      appended.push([offset, this.req.headers["upload-complete"], body.length]);
      const next = offset + 4 >= jpeg.length ? jpeg.length : offset + 4;
      return [200, state(next, next === jpeg.length ? "verified" : "receiving")];
    });
  const receipt = { assetId: id(600000), status: "created", sha256: sha };
  connect()
    .post(`/api/connect/uploads/${uploadId}/commit`, (body) => body.sha256 === sha && body.requestId === starts[0].requestId)
    .reply(200, receipt);
  const result = await perform("creates.upload_file.operation.perform", upload);
  assert.equal(result.assetId, receipt.assetId);
  assert.deepEqual(
    appended.map(([offset, complete]) => [offset, complete]),
    [
      [0, "?0"],
      [4, "?0"],
      [8, "?1"],
    ],
  );
  assert.equal(starts[0].contentType, "image/jpeg");
  assert.equal(starts[0].filename, "photo.jpg");
  assert.equal(starts[0].fileCreatedAt, "2026-01-01T10:00:00.000Z");

  // A Zapier replay of the same source sends an identical start payload and request ID, so the
  // Library returns the existing receipt instead of creating a duplicate.
  nock(source).get("/photo.jpeg").reply(200, jpeg);
  connect().get("/api/connect/capabilities").reply(200, capabilities());
  connect()
    .post("/api/connect/uploads", (body) => starts.push(body))
    .reply(201, state(jpeg.length, "published", receipt));
  const replay = await perform("creates.upload_file.operation.perform", upload);
  assert.equal(replay.assetId, receipt.assetId);
  assert.deepEqual(starts[1], starts[0]);
});

test("a concurrent run that moved the offset is resumed from the durable state", async () => {
  nock(source).get("/photo.jpeg").reply(200, jpeg);
  connect().get("/api/connect/capabilities").reply(200, capabilities({ limits: { maxUploadBytes: 1000, maxAppendBytes: 100 } }));
  connect().post("/api/connect/uploads").reply(201, state(0));
  connect().patch(`/api/connect/uploads/${uploadId}`).reply(409, {});
  connect().get(`/api/connect/uploads/${uploadId}`).reply(200, state(jpeg.length, "verified"));
  connect()
    .post(`/api/connect/uploads/${uploadId}/commit`)
    .reply(200, { assetId: id(600001), status: "duplicate", sha256: "a".repeat(64) });
  const result = await perform("creates.upload_file.operation.perform", upload);
  assert.equal(result.status, "duplicate");
});

test("upload refuses unsafe, oversized and mismatched sources before starting", async () => {
  const refuse = async (inputData, setup, expected) => {
    connect().get("/api/connect/capabilities").reply(200, capabilities());
    setup?.();
    await assert.rejects(
      () => perform("creates.upload_file.operation.perform", { ...upload, ...inputData }),
      (e) => !expected || code(e) === expected,
    );
  };
  await refuse({ file: "http://files.example.net/photo.jpeg" }, null, "InvalidSource");
  await refuse({ file: "https://127.0.0.1/photo.jpeg" }, null, "InvalidSource");
  await refuse({ file: "https://nas.local/photo.jpeg" }, null, "InvalidSource");
  await refuse({ file: "https://rebind.example.net/photo.jpeg" }, null, "InvalidSource");
  await refuse({}, () =>
    nock(source).get("/photo.jpeg").reply(302, "", { Location: "http://files.example.net/x.jpeg" }),
    "InvalidSource",
  );
  await refuse({}, () => nock(source).get("/photo.jpeg").reply(200, Buffer.alloc(1001, 0xff)), "TooLarge");
  await refuse({}, () => nock(source).get("/photo.jpeg").reply(200, Buffer.from("%PDF-1.7 synthetic")), "UnsupportedType");
  await refuse({}, () => nock(source).get("/photo.jpeg").reply(404), "SourceFailed");
  await refuse({ albumId: id(1) }, null, "Forbidden");
  await assert.rejects(() => perform("creates.upload_file.operation.perform", { ...upload, sourceId: " " }));
});

test("album creation is idempotent per Source ID and refuses a reused one with new details", async () => {
  const bodies = [];
  connect()
    .post("/api/connect/albums", (body) => bodies.push(body))
    .twice()
    .reply(201, { id: albumId, name: "Trips", workspace: "photo", canRead: true, canWrite: true });
  const input = { name: " Trips ", workspace: "photo", sourceId: "sheet-row-3" };
  await perform("creates.create_album.operation.perform", input);
  await perform("creates.create_album.operation.perform", input);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies[0].name, "Trips");
  assert.match(bodies[0].requestId, /^zapier-album-[a-f0-9]{64}$/);
  assert.ok(bodies[0].requestId.length <= 200);

  connect().post("/api/connect/albums").reply(409, { message: "Request ID payload changed" });
  await assert.rejects(
    () => perform("creates.create_album.operation.perform", { ...input, name: "Other" }),
    (e) => code(e) === "SourceIdReused",
  );
});

test("searches, album additions and tags send only validated, bounded input", async () => {
  connect()
    .get("/api/connect/assets")
    .query({ page: 1, size: 25, q: "beach", albumId, type: "VIDEO" })
    .reply(200, {
      items: [{ id: id(3), type: "VIDEO", title: null, description: "Sea", width: 1, height: 1, duration: 5, createdAt: "x", updatedAt: "x" }],
      total: 1,
      page: 1,
      size: 25,
    });
  const found = await perform("searches.find_asset.operation.perform", { q: "beach", albumId, type: "VIDEO" });
  assert.equal(found[0].description, "Sea");

  connect().get(`/api/connect/assets/${id(4)}`).reply(404, {});
  assert.deepEqual(await perform("searches.find_asset.operation.perform", { assetId: id(4) }), []);

  connect()
    .get("/api/connect/albums")
    .twice()
    .reply(200, {
      items: [
        { id: albumId, name: "Trips", workspace: "photo", canRead: true, canWrite: false },
        { id: id(2), name: "Inbox", workspace: "design", canRead: false, canWrite: true },
      ],
    });
  assert.deepEqual(
    (await perform("searches.find_album.operation.perform", { name: " trips" })).map((a) => a.id),
    [albumId],
  );
  assert.deepEqual(
    (await perform("triggers.writable_album_list.operation.perform")).map((a) => a.id),
    [id(2)],
  );

  connect()
    .post(`/api/connect/albums/${albumId}/assets`, { assetIds: [id(5), id(6)] })
    .reply(201, [
      { id: id(5), success: true },
      { id: id(6), success: false, error: "duplicate" },
    ]);
  const added = await perform("creates.add_to_album.operation.perform", { albumId, assetIds: [id(5), id(6)] });
  assert.deepEqual([added.added, added.alreadyPresent, added.failed], [[id(5)], [id(6)], []]);

  connect().post(`/api/connect/assets/${id(5)}/tags`, { tags: ["Sunset", "2026"] }).reply(201, { tagIds: [id(7)] });
  assert.deepEqual((await perform("creates.add_tags.operation.perform", { assetId: id(5), tags: ["Sunset ", "2026"] })).tagIds, [id(7)]);

  for (const [path, input] of [
    ["creates.add_tags.operation.perform", { assetId: id(5), tags: ["a/b"] }],
    ["creates.add_tags.operation.perform", { assetId: id(5), tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
    ["creates.add_to_album.operation.perform", { albumId, assetIds: Array.from({ length: 101 }, (_, i) => id(i)) }],
    ["creates.add_to_album.operation.perform", { albumId, assetIds: ["../admin"] }],
  ])
    await assert.rejects(() => perform(path, input));
});
