const assert = require("node:assert/strict");
const { test, afterEach } = require("node:test");
const nock = require("nock");
const core = require("zapier-platform-core");
const App = require("../index");
const run = core.createAppTester(App);
nock.disableNetConnect();
afterEach(() => {
  assert.deepEqual(nock.pendingMocks(), []);
  nock.cleanAll();
});
const origin = "https://photos.example.org";
const authData = {
  serverUrl: origin,
  frameleafClientId: "synthetic-client",
  frameleafBoundClientId: "synthetic-client",
  frameleafResource: origin + "/api/connect",
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "library:read",
};
const nextTokens = {
  access_token: "synthetic-next-access",
  refresh_token: "synthetic-next-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "library:read",
};

test("real Zapier core sends bounded token exchange with the supplied PKCE verifier", async () => {
  const inputData = {
    serverUrl: origin,
    frameleafClientId: "synthetic-client",
    code: "synthetic-code",
    code_verifier: "v".repeat(43),
    redirect_uri:
      "https://zapier.com/dashboard/auth/oauth/return/App123CLIAPI/",
  };
  nock(origin)
    .post(
      "/api/oauth/apps/token",
      (body) =>
        body.client_id === "synthetic-client" &&
        body.code_verifier === inputData.code_verifier &&
        body.resource === origin + "/api/connect" &&
        !Object.hasOwn(body, "client_secret"),
    )
    .reply(200, nextTokens);
  const result = await run(App.authentication.oauth2Config.getAccessToken, {
    inputData,
  });
  assert.equal(result.refresh_token, nextTokens.refresh_token);
  assert.equal(result.frameleafResource, origin + "/api/connect");
});
test("real Zapier core preserves full rotated set and uses immutable binding", async () => {
  nock(origin)
    .post(
      "/api/oauth/apps/token",
      (body) =>
        body.refresh_token === authData.refresh_token &&
        body.resource === authData.frameleafResource,
    )
    .reply(200, nextTokens);
  const result = await run(App.authentication.oauth2Config.refreshAccessToken, {
    authData,
  });
  assert.deepEqual(result, { ...authData, ...nextTokens });
  await assert.rejects(() =>
    run(App.authentication.test, {
      authData: { ...result, serverUrl: "https://other.example.org" },
    }),
  );
});
test("real Zapier core refuses token redirects without forwarding credentials", async () => {
  nock(origin)
    .post("/api/oauth/apps/token")
    .reply(307, "", { Location: "https://unrelated.example.org/receive" });
  await assert.rejects(
    () => run(App.authentication.oauth2Config.refreshAccessToken, { authData }),
    (error) => !String(error).includes("synthetic-refresh"),
  );
});
test("real Zapier core raises native refresh request for an expired access token", async () => {
  nock(origin)
    .get("/api/connect/capabilities")
    .matchHeader("authorization", "Bearer " + authData.access_token)
    .reply(401, {});
  await assert.rejects(
    () => run(App.authentication.test, { authData }),
    (error) => error.name === "RefreshAuthError",
  );
});
test("real Zapier core preserves read throttling and its retry delay", async () => {
  nock(origin)
    .get("/api/connect/capabilities")
    .reply(429, {}, { "Retry-After": "120" });
  await assert.rejects(
    () => run(App.authentication.test, { authData }),
    (error) =>
      error.name === "ThrottledError" &&
      JSON.parse(error.message).delay === 120,
  );
});
test("separate core refresh invocations are not a proof of hosted rotation coordination", async () => {
  let dispatched = 0;
  nock(origin)
    .post("/api/oauth/apps/token")
    .twice()
    .reply(() => [
      ++dispatched === 1 ? 200 : 400,
      dispatched === 1 ? nextTokens : { error: "invalid_grant" },
    ]);
  const results = await Promise.allSettled([
    run(App.authentication.oauth2Config.refreshAccessToken, {
      authData: { ...authData },
    }),
    run(App.authentication.oauth2Config.refreshAccessToken, {
      authData: { ...authData },
    }),
  ]);
  assert.equal(dispatched, 2);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
});

test("real Zapier core redacts stored and newly returned tokens in native logs", async () => {
  const logs = [];
  nock(origin).post("/api/oauth/apps/token").reply(200, nextTokens);
  const handler = core.createAppHandler(App);
  await handler({
    command: "execute",
    method: "authentication.oauth2Config.refreshAccessToken",
    bundle: { authData },
    customLogger: (message, data) => logs.push({ message, data }),
  });
  const rendered = JSON.stringify(logs);
  assert.ok(logs.length > 0);
  for (const secret of [
    authData.access_token,
    authData.refresh_token,
    nextTokens.access_token,
    nextTokens.refresh_token,
  ])
    assert.ok(!rendered.includes(secret));
});
test("real Zapier core bounds oversized and invalid token responses without copying body into errors", async () => {
  nock(origin).post("/api/oauth/apps/token").reply(200, "s".repeat(70000));
  await assert.rejects(
    () => run(App.authentication.oauth2Config.refreshAccessToken, { authData }),
    (error) => !String(error).includes("s".repeat(100)),
  );
});
