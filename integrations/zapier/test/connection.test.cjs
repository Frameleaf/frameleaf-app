const assert = require("node:assert/strict");
const { test } = require("node:test");
const auth = require("../authentication")();
const { authorizeUrl, getAccessToken, refreshAccessToken } = auth.oauth2Config;
const origin = "https://photos.example.org";
const client = "synthetic-client";
const redirect = "https://zapier.com/dashboard/auth/oauth/return/App123CLIAPI/";
const input = {
  serverUrl: origin,
  frameleafClientId: client,
  redirect_uri: redirect,
  state: "synthetic-state",
  code: "synthetic-code",
  code_verifier: "v".repeat(43),
};
const tokens = {
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "library:read",
};
const bound = {
  ...tokens,
  serverUrl: origin,
  frameleafClientId: client,
  frameleafResource: origin + "/api/connect",
  frameleafBoundClientId: client,
};
const response = (data, status = 200) => ({
  status,
  content: JSON.stringify(data),
  data,
});
const z = (request) => ({
  request,
  errors: {
    RefreshAuthError: class RefreshAuthError extends Error {},
    ThrottledError: class ThrottledError extends Error {},
    ExpiredAuthError: class ExpiredAuthError extends Error {},
  },
});

test("native PKCE and per-server public client inputs are read-only", () => {
  assert.equal(auth.type, "oauth2");
  assert.equal(auth.oauth2Config.enablePkce, true);
  assert.equal(auth.oauth2Config.autoRefresh, true);
  assert.equal(auth.oauth2Config.scope, "library:read");
  assert.deepEqual(
    auth.fields.filter((f) => !f.computed).map((f) => f.key),
    ["serverUrl", "frameleafClientId"],
  );
  assert.ok(
    !auth.fields.some((f) => ["client_id", "client_secret"].includes(f.key)),
  );
});
test("authorization binds exact resource, client, state and platform callback", async () => {
  const url = new URL(
    await authorizeUrl(
      z(() => assert.fail("no request")),
      { inputData: input },
    ),
  );
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, "/api/oauth/apps/authorize");
  for (const [key, value] of Object.entries({
    client_id: client,
    redirect_uri: redirect,
    state: input.state,
    response_type: "code",
    resource: origin + "/api/connect",
    scope: "library:read",
  }))
    assert.equal(url.searchParams.get(key), value);
  assert.equal(url.searchParams.has("client_secret"), false);
});
test("refuses malformed, noncanonical and private origins before dispatch", async () => {
  for (const serverUrl of [
    "http://photos.example.org",
    "https://photos.example.org/",
    "https://photos.example.org/path",
    "https://user:pass@photos.example.org",
    "https://photos.example.org?x=1",
    "https://127.0.0.1",
    "https://[::1]",
    "https://library.local",
    "https://library.local.",
    "https://localhost",
    "https://photos.example.org#x",
  ])
    await assert.rejects(() =>
      authorizeUrl(
        z(() => assert.fail("no dispatch")),
        { inputData: { ...input, serverUrl } },
      ),
    );
  for (const redirect_uri of [
    "http://zapier.com/return",
    "https://zapier.com.attacker.example/return",
    "https://person@zapier.com/return",
  ])
    await assert.rejects(() =>
      authorizeUrl(
        z(() => assert.fail("no dispatch")),
        { inputData: { ...input, redirect_uri } },
      ),
    );
});
test("code exchange returns only complete tokens and pinned connection fields", async () => {
  let count = 0;
  const result = await getAccessToken(
    z(async (options) => {
      count++;
      assert.equal(options.url, origin + "/api/oauth/apps/token");
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      assert.equal(options.timeout, 10000);
      assert.equal(options.size, 65536);
      assert.equal(options.headers.Authorization, undefined);
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code_verifier"), input.code_verifier);
      assert.equal(body.get("client_id"), client);
      assert.equal(body.get("resource"), origin + "/api/connect");
      assert.equal(body.get("redirect_uri"), redirect);
      assert.equal(body.has("client_secret"), false);
      return response({ ...tokens, unexpected: "discard" });
    }),
    { inputData: input },
  );
  assert.equal(count, 1);
  assert.deepEqual(result, bound);
});
test("refresh returns the full replacement token set without reusing the old refresh token", async () => {
  let count = 0;
  const result = await refreshAccessToken(
    z(async (options) => {
      count++;
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), tokens.refresh_token);
      assert.equal(body.get("resource"), origin + "/api/connect");
      assert.equal(body.get("client_id"), client);
      return response({
        ...tokens,
        access_token: "next-access",
        refresh_token: "next-refresh",
      });
    }),
    { authData: bound, inputData: {} },
  );
  assert.equal(count, 1);
  assert.equal(result.access_token, "next-access");
  assert.equal(result.refresh_token, "next-refresh");
  assert.equal(result.frameleafResource, bound.frameleafResource);
});
test("resource/client changes and incomplete binding never send a stored token", async () => {
  for (const changed of [
    { serverUrl: "https://other.example.org" },
    { frameleafClientId: "other-client" },
    { frameleafResource: "https://other.example.org/api/connect" },
    { frameleafResource: undefined },
    { frameleafBoundClientId: undefined },
  ])
    await assert.rejects(() =>
      refreshAccessToken(
        z(() => assert.fail("no dispatch")),
        { authData: { ...bound, ...changed }, inputData: {} },
      ),
    );
});
test("rejects missing/unchanged refresh, broader scope, bad token type and malformed tokens", async () => {
  for (const changed of [
    { refresh_token: undefined },
    { refresh_token: tokens.refresh_token },
    { scope: "library:read photos:upload" },
    { token_type: "Basic" },
    { access_token: "" },
    { expires_in: 0 },
  ])
    await assert.rejects(() =>
      refreshAccessToken(
        z(async () =>
          response({ ...tokens, refresh_token: "next-refresh", ...changed }),
        ),
        { authData: bound, inputData: {} },
      ),
    );
});
test("uncertain refresh and remote errors never retry or expose response content", async () => {
  for (const mode of ["transport", "response", "json"]) {
    let count = 0;
    await assert.rejects(
      () =>
        refreshAccessToken(
          z(async () => {
            count++;
            if (mode === "transport") throw Error("private-token-and-url");
            if (mode === "json")
              return { status: 200, content: "private-token-and-url" };
            return response({ error: "private-token-and-url" }, 400);
          }),
          { authData: bound, inputData: {} },
        ),
      (error) => !error.message.includes("private-token-and-url"),
    );
    assert.equal(count, 1);
  }
});
test("connection test signs only the pinned capabilities endpoint and returns a safe label", async () => {
  const result = await auth.test(
    z(async (options) => {
      assert.equal(options.url, origin + "/api/connect/capabilities");
      assert.equal(
        options.headers.Authorization,
        "Bearer " + tokens.access_token,
      );
      return response({
        protocolVersion: 1,
        server: { id: "11111111-1111-4111-8111-111111111111" },
        connection: {
          grantId: "22222222-2222-4222-8222-222222222222",
          libraryUserId: "33333333-3333-4333-8333-333333333333",
        },
        scopes: ["library:read"],
        privateField: "omit",
      });
    }),
    { authData: bound },
  );
  assert.deepEqual(result, { serverUrl: origin });
});
test("expired access delegates to native refresh, while invalid token responses stop", async () => {
  const native = z(async () => response({}, 401));
  await assert.rejects(
    () => auth.test(native, { authData: bound }),
    native.errors.RefreshAuthError,
  );
  await assert.rejects(
    () => refreshAccessToken(native, { authData: bound }),
    native.errors.ExpiredAuthError,
  );
});

test("all eleven catalogues render static labels and translated help without claiming native localization", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const locales = require("../locales.json");
  const create = require("../authentication");
  assert.deepEqual(
    Object.keys(locales).sort(),
    [
      "en",
      "fr",
      "es",
      "de",
      "it",
      "pt",
      "nl",
      "pl",
      "sv",
      "da",
      "nb_NO",
    ].sort(),
  );
  for (const [locale, messages] of Object.entries(locales)) {
    assert.deepEqual(Object.keys(messages), Object.keys(locales.en));
    for (const [key, value] of Object.entries(messages)) {
      assert.ok(typeof value === "string" && value.trim());
      if (locale !== "en" && key !== "heading")
        assert.notEqual(value, locales.en[key]);
    }
    const translated = create(locale);
    const rendered = require("node:child_process").execFileSync(
      process.execPath,
      [path.join(__dirname, "../render.cjs"), locale],
      { encoding: "utf8" },
    );
    const module = { exports: {} };
    require("node:vm").runInNewContext(rendered, {
      module,
      require: require("node:module").createRequire(
        path.join(__dirname, "../index.js"),
      ),
    });
    assert.equal(
      module.exports.authentication.fields[0].label,
      messages.serverLabel,
    );
    assert.equal(
      module.exports.platformVersion,
      require("zapier-platform-core").version,
    );
    assert.equal(translated.fields[0].label, messages.serverLabel);
    assert.equal(translated.fields[1].helpText, messages.clientHelp);
    const help = fs.readFileSync(
      path.join(__dirname, "../../help/zapier", locale + ".md"),
      "utf8",
    );
    assert.ok(help.includes(messages.qualification));
    assert.ok(help.includes(messages.hosting));
  }
  assert.throws(() => create("../en"));
  assert.throws(() => create("toString"));
});
