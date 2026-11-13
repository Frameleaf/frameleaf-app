import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { connect, ConnectDisplay } from "../simulator.mjs";

async function fixture(t, options = {}) {
  const seen = [];
  let rotates = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({
      path: req.url,
      authorization: req.headers.authorization,
      body,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/oauth/apps/token") {
      if (new URLSearchParams(body).get("refresh_token") !== "refresh-1") {
        res.writeHead(400);
        return res.end("{}");
      }
      rotates++;
      options.rotating?.resolve();
      if (options.releaseRefresh) await options.releaseRefresh.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (options.loseRefreshResponse) {
        res.writeHead(503);
        return res.end("{}");
      }
      return res.end(
        JSON.stringify({
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      );
    }
    if (req.url === "/api/oauth/apps/revoke") {
      if (options.revokeFailures > 0) {
        options.revokeFailures--;
        res.writeHead(503);
      }
      return res.end("{}");
    }
    if (req.headers.authorization !== "Bearer access-2") {
      res.writeHead(401);
      return res.end("{}");
    }
    if (req.url === "/api/connect/albums")
      return res.end(
        JSON.stringify({
          items: [{ id: "album-a", name: "Synthetic", canRead: true }],
        }),
      );
    if (req.url?.startsWith("/api/connect/assets?"))
      return res.end(
        JSON.stringify({
          items: [{ id: "image-a", type: "IMAGE" }],
          total: 1,
          page: 1,
          size: 100,
        }),
      );
    if (req.url?.endsWith("/rendition?variant=display")) {
      res.setHeader("Content-Type", "image/jpeg");
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const display = new ConnectDisplay(origin, "client-a");
  display.acceptTokens({
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 0,
    token_type: "Bearer",
  });
  return { origin, display, seen, rotates: () => rotates };
}

test("concurrent metadata and image requests rotate once and use only the Connect audience", async (t) => {
  const f = await fixture(t);
  const [albums, photos] = await Promise.all([
    f.display.albums(),
    f.display.photos("album-a"),
  ]);
  assert.equal(albums.items[0].id, "album-a");
  assert.equal(photos.items[0].id, "image-a");
  assert.equal(f.rotates(), 1);
  const refresh = new URLSearchParams(
    f.seen.find((x) => x.path === "/api/oauth/apps/token").body,
  );
  assert.equal(refresh.get("resource"), `${f.origin}/api/connect`);
  assert.equal(refresh.get("client_id"), "client-a");
  assert.deepEqual(await f.display.prefetch(["image-a", "image-b"]), [
    Buffer.from([255, 216, 255, 217]),
    Buffer.from([255, 216, 255, 217]),
  ]);
  assert.equal(f.rotates(), 1);
});

test("prefetch is bounded to current and next and disconnect clears credentials", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.display.prefetch(["a", "b", "c"]), /current and next/);
  assert.equal(f.seen.length, 0);
  await f.display.disconnect();
  await assert.rejects(f.display.albums(), /Connect again/);
  assert.deepEqual(
    f.seen.map((x) => x.path),
    ["/api/oauth/apps/revoke"],
  );
});

test("simultaneous 401 responses share one rotated token set", async (t) => {
  const f = await fixture(t);
  f.display.acceptTokens({
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 3600,
    token_type: "Bearer",
  });
  await Promise.all([
    f.display.albums(),
    f.display.photos("album-a"),
    f.display.albums(),
  ]);
  assert.equal(f.rotates(), 1);
  await f.display.disconnect();
  const revoke = f.seen.find((x) => x.path === "/api/oauth/apps/revoke");
  assert.equal(new URLSearchParams(revoke.body).get("token"), "refresh-2");
});

test("disconnect waits for an in-flight rotation and revokes the new token without another media fetch", async (t) => {
  const rotating = Promise.withResolvers();
  const releaseRefresh = Promise.withResolvers();
  const f = await fixture(t, { rotating, releaseRefresh });
  const pendingRequest = assert.rejects(f.display.albums(), /Connect again/);
  await rotating.promise;
  const disconnected = Promise.all([
    f.display.disconnect(),
    f.display.disconnect(),
  ]);
  releaseRefresh.resolve();
  await Promise.all([pendingRequest, disconnected]);
  assert.deepEqual(
    f.seen.map((x) => x.path),
    ["/api/oauth/apps/token", "/api/oauth/apps/revoke"],
  );
  assert.equal(new URLSearchParams(f.seen[1].body).get("token"), "refresh-2");
  await assert.rejects(f.display.albums(), /Connect again/);
});

test("a failed revocation can be retried while media requests stay disconnected", async (t) => {
  const f = await fixture(t, { revokeFailures: 1 });
  await assert.rejects(f.display.disconnect(), /503/);
  await assert.rejects(f.display.albums(), /Connect again/);
  await f.display.disconnect();
  const revocations = f.seen.filter((x) => x.path === "/api/oauth/apps/revoke");
  assert.equal(revocations.length, 2);
  assert.ok(
    revocations.every(
      (x) => new URLSearchParams(x.body).get("token") === "refresh-1",
    ),
  );
});

test("an uncertain rotation retains the last refresh token for revocation", async (t) => {
  const f = await fixture(t, { loseRefreshResponse: true });
  await assert.rejects(f.display.albums(), /could not be renewed/);
  await assert.rejects(f.display.albums(), /Connect again/);
  await f.display.disconnect();
  assert.equal(f.rotates(), 1);
  const revoke = f.seen.find((x) => x.path === "/api/oauth/apps/revoke");
  assert.equal(new URLSearchParams(revoke.body).get("token"), "refresh-1");
});

test("invalid token responses never become usable connections", async (t) => {
  const f = await fixture(t);
  for (const value of [
    { access_token: "token" },
    {
      access_token: "token",
      refresh_token: "refresh",
      expires_in: 300,
      token_type: "Basic",
    },
  ]) {
    assert.throws(() => f.display.acceptTokens(value), /Invalid OAuth/);
  }
});

test("the simulator refuses credentials in URLs, paths and non-loopback HTTP origins", () => {
  for (const url of [
    "http://photos.example",
    "https://user:pass@example.com",
    "https://example.com/private",
    "https://example.com/?token=secret",
  ]) {
    assert.throws(() => new ConnectDisplay(url, "client"), /Library origin/);
  }
});

test("DCR and browser callback complete S256 exchange and reject an incorrect state", async (t) => {
  let origin,
    callback,
    challenge,
    exchanged = false;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/.well-known/oauth-protected-resource/api/connect")
      return res.end(
        JSON.stringify({
          resource: `${origin}/api/connect`,
          authorization_servers: [origin],
        }),
      );
    if (req.url === "/.well-known/oauth-authorization-server")
      return res.end(
        JSON.stringify({
          authorization_endpoint: `${origin}/api/oauth/apps/authorize`,
          token_endpoint: `${origin}/api/oauth/apps/token`,
          registration_endpoint: `${origin}/api/oauth/apps/register`,
        }),
      );
    if (req.url === "/api/oauth/apps/register") {
      const registration = JSON.parse(body);
      callback = registration.redirect_uris[0];
      assert.equal(registration.token_endpoint_auth_method, "none");
      assert.equal(new URL(callback).hostname, "127.0.0.1");
      return res.end(JSON.stringify({ client_id: "client-a" }));
    }
    if (req.url === "/api/oauth/apps/token") {
      const form = new URLSearchParams(body);
      assert.equal(form.get("redirect_uri"), callback);
      assert.equal(form.get("code"), "synthetic-code");
      assert.equal(form.get("resource"), `${origin}/api/connect`);
      assert.equal(
        createHash("sha256")
          .update(form.get("code_verifier"))
          .digest("base64url"),
        challenge,
      );
      exchanged = true;
      return res.end(
        JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      );
    }
    if (req.url === "/api/oauth/apps/revoke") return res.end("{}");
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  origin = `http://127.0.0.1:${server.address().port}`;
  const display = await connect(origin, undefined, async (authorizationUrl) => {
    const authorization = new URL(authorizationUrl);
    assert.equal(authorization.searchParams.get("scope"), "library:read");
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    challenge = authorization.searchParams.get("code_challenge");
    const rejected = await fetch(`${callback}?code=synthetic-code&state=wrong`);
    assert.equal(rejected.status, 400);
    assert.equal(exchanged, false);
    const accepted = await fetch(
      `${callback}?${new URLSearchParams({ code: "synthetic-code", state: authorization.searchParams.get("state") })}`,
    );
    assert.equal(accepted.status, 200);
  });
  assert.equal(exchanged, true);
  await display.disconnect();
});
