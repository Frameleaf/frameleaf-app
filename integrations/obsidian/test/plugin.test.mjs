import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import Module from "node:module";

// Obsidian supplies the "obsidian" module at runtime; tests substitute the few parts main.js touches.
let language = "en";
async function requestUrl({ url, method, headers, body, contentType }) {
  const response = await fetch(url, {
    method,
    body,
    redirect: "manual",
    headers: {
      ...headers,
      ...(contentType && { "Content-Type": contentType }),
    },
  });
  return { status: response.status, arrayBuffer: await response.arrayBuffer() };
}
const fakeObsidian = {
  Plugin: class {},
  Modal: class {},
  PluginSettingTab: class {},
  Setting: class {},
  Notice: class {},
  MarkdownView: class {},
  requestUrl,
  getLanguage: () => language,
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "obsidian"
    ? fakeObsidian
    : load.call(this, request, ...rest);
};
const { internals } = createRequire(import.meta.url)("../main.js");
const {
  libraryOrigin,
  pkce,
  secretId,
  attachmentPrefix,
  imageExtension,
  altText,
  listenForCode,
  Connection,
  saveAttachment,
  MESSAGES,
  t,
} = internals;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const ASSET = {
  id: "11111111-2222-4333-8444-555555555555",
  type: "IMAGE",
  title: "Lake | 300",
  description: null,
  updatedAt: "2026-11-01T10:00:00.000Z",
};
const USER = "99999999-8888-4777-8666-555555555555";

test("Library origins are HTTPS (or loopback HTTP) without credentials, paths or queries", () => {
  assert.equal(
    libraryOrigin(" https://photos.example.com/ "),
    "https://photos.example.com",
  );
  assert.equal(libraryOrigin("http://127.0.0.1:2283"), "http://127.0.0.1:2283");
  for (const bad of [
    "http://photos.example.com",
    "http://192.168.1.2:2283",
    "https://u:p@photos.example.com",
    "https://photos.example.com/api",
    "https://photos.example.com/?a=1",
    "ftp://photos.example.com",
    "not a url",
    "",
  ]) {
    assert.throws(() => libraryOrigin(bad), { code: "invalid_origin" }, bad);
  }
});

test("PKCE uses S256 and fresh random state", () => {
  const a = pkce();
  const b = pkce();
  assert.equal(
    a.challenge,
    createHash("sha256").update(a.verifier).digest("base64url"),
  );
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.state, b.state);
});

test("secret IDs are valid for SecretStorage and namespaced by vault, Library and account", () => {
  const id = secretId("vault", "server", USER);
  assert.match(id, /^[a-z0-9-]+$/);
  assert.equal(id, secretId("vault", "server", USER));
  assert.notEqual(id, secretId("other", "server", USER));
  assert.notEqual(id, secretId("vault", "other", USER));
  assert.notEqual(id, secretId("vault", "server", "someone"));
});

test("attachment names are stable per asset, revision and variant", () => {
  const name = attachmentPrefix(ASSET);
  assert.match(
    name,
    /^frameleaf-11111111-2222-4333-8444-555555555555-[a-z0-9]+-preview\.$/,
  );
  assert.equal(attachmentPrefix({ ...ASSET }), name);
  assert.notEqual(
    attachmentPrefix({ ...ASSET, updatedAt: "2026-11-02T10:00:00.000Z" }),
    name,
  );
  assert.throws(() => attachmentPrefix({ ...ASSET, id: "../x" }), {
    code: "unsupported_image",
  });
  assert.throws(() => attachmentPrefix({ ...ASSET, type: "VIDEO" }), {
    code: "unsupported_image",
  });
});

test("only JPEG, PNG and WebP bytes are accepted", () => {
  assert.equal(imageExtension(JPEG), "jpg");
  assert.equal(
    imageExtension(Buffer.from("\x89PNG\r\n\x1a\n", "latin1")),
    "png",
  );
  assert.equal(
    imageExtension(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")),
    "webp",
  );
  assert.throws(() => imageExtension(Buffer.from("<svg onload=alert(1)>")), {
    code: "unsupported_image",
  });
});

test("alt text cannot break out of wikilinks or Markdown links", () => {
  assert.equal(altText("Lake | 300"), "Lake 300");
  assert.equal(altText("a]](evil)![[x#^y\n`*_<b>"), "a (evil) x y b");
  assert.equal(altText("300"), "");
  assert.equal(altText("640x480"), "");
  assert.equal(altText(null), "");
  assert.equal(altText("x".repeat(500)).length, 200);
});

test("every language has every message", () => {
  const keys = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(Object.keys(MESSAGES).sort(), [
    "da",
    "de",
    "en",
    "es",
    "fr",
    "it",
    "nb",
    "nl",
    "pl",
    "pt",
    "sv",
  ]);
  for (const [code, messages] of Object.entries(MESSAGES))
    assert.deepEqual(Object.keys(messages).sort(), keys, code);
  language = "no";
  assert.equal(t("connect"), "Koble til");
  language = "pt-BR";
  assert.equal(t("connect"), "Ligar");
  language = "zz";
  assert.equal(t("connect"), "Connect");
  assert.equal(t(undefined), MESSAGES.en.connection_failed);
  language = "en";
});

test("the loopback receiver ignores forged callbacks, accepts the real one once and closes", async () => {
  const { ready, result, server } = listenForCode("s".repeat(43));
  const uri = await ready;
  assert.match(uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(server.address().address, "127.0.0.1");
  assert.equal((await fetch(`${uri}?code=x&state=wrong`)).status, 400);
  assert.equal(
    (
      await fetch(
        `${uri.replace("/callback", "/other")}?code=x&state=${"s".repeat(43)}`,
      )
    ).status,
    400,
  );
  const ok = await fetch(`${uri}?code=abc&state=${"s".repeat(43)}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(await result, "abc");
  await assert.rejects(fetch(`${uri}?code=again&state=${"s".repeat(43)}`));
});

test("the loopback receiver reports denial, expiry and cancellation", async () => {
  const denied = listenForCode("d".repeat(43));
  await fetch(
    `${await denied.ready}?error=access_denied&state=${"d".repeat(43)}`,
  );
  await assert.rejects(denied.result, { code: "denied" });

  const expired = listenForCode("e".repeat(43), 50);
  const expiredUri = await expired.ready;
  await assert.rejects(expired.result, { code: "expired" });
  await assert.rejects(fetch(expiredUri));

  const cancelled = listenForCode("c".repeat(43));
  await cancelled.ready;
  cancelled.cancel();
  await assert.rejects(cancelled.result, { code: "cancelled" });
  assert.equal(cancelled.server.listening, false);
});

async function library(t, options = {}) {
  const seen = { renditions: 0, refreshes: 0, revoked: [], registered: [] };
  let issued = 0;
  let refreshToken;
  const challenges = new Map();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, origin);
    const send = (status, value, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(type === "application/json" ? JSON.stringify(value) : value);
    };
    const authorized = () =>
      req.headers.authorization === `Bearer access-${issued}`;
    const tokens = () => {
      issued += 1;
      refreshToken = `refresh-${issued}`;
      return {
        access_token: `access-${issued}`,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: options.expiresIn ?? 900,
        scope: "library:read",
      };
    };
    switch (url.pathname) {
      case "/.well-known/oauth-authorization-server":
        return send(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/api/oauth/apps/authorize`,
          token_endpoint: `${origin}/api/oauth/apps/token`,
          revocation_endpoint: `${origin}/api/oauth/apps/revoke`,
          registration_endpoint: `${origin}/api/oauth/apps/register`,
          code_challenge_methods_supported: ["S256"],
        });
      case "/api/oauth/apps/register":
        seen.registered.push(JSON.parse(body));
        return send(201, { client_id: "client-1" });
      case "/api/oauth/apps/token": {
        const form = new URLSearchParams(body);
        assert.equal(form.get("resource"), `${origin}/api/connect`);
        if (form.get("grant_type") === "authorization_code") {
          const challenge = challenges.get(form.get("code"));
          if (
            !challenge ||
            createHash("sha256")
              .update(form.get("code_verifier"))
              .digest("base64url") !== challenge
          )
            return send(400, { error: "invalid_grant" });
          return send(200, tokens());
        }
        seen.refreshes += 1;
        if (options.refuseRefresh || form.get("refresh_token") !== refreshToken)
          return send(400, { error: "invalid_grant" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return send(200, tokens());
      }
      case "/api/oauth/apps/revoke":
        seen.revoked.push(new URLSearchParams(body).get("token"));
        return send(200, {});
      case "/api/connect/capabilities":
        if (!authorized()) return send(401, {});
        return send(200, {
          protocolVersion: 1,
          server: { id: "server-1", name: "Home" },
          displayIdentity: { name: "Sam" },
          connection: { grantId: USER, libraryUserId: USER },
          scopes: ["library:read"],
        });
      case "/api/connect/albums":
        if (!authorized()) return send(401, {});
        return send(200, {
          items: [
            { id: USER, name: "Trips", canRead: true },
            { id: ASSET.id, name: "Write only", canRead: false },
          ],
        });
      case "/api/connect/assets":
        if (!authorized()) return send(401, {});
        assert.equal(url.searchParams.get("type"), "IMAGE");
        return send(200, {
          items: [ASSET, { ...ASSET, id: "bad" }],
          total: 1,
          page: 1,
          size: 40,
        });
      case `/api/connect/assets/${ASSET.id}/rendition`:
        if (!authorized()) return send(401, {});
        seen.renditions += 1;
        assert.equal(url.searchParams.get("variant"), "preview");
        if (options.interrupt) return req.socket.destroy();
        return send(200, JPEG, "image/jpeg");
      default:
        return send(404, {});
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const secrets = new Map();
  const saved = [];
  const settings = {
    vaultKey: "a".repeat(32),
    origin: "",
    clientId: "",
    serverId: "",
    accountId: "",
    serverName: "",
    accountName: "",
    sourceLink: false,
  };
  const connection = new Connection({
    settings,
    secrets: {
      setSecret: (id, value) => secrets.set(id, value),
      getSecret: (id) => secrets.get(id) || null,
    },
    save: async () => saved.push(JSON.stringify(settings)),
    request: requestUrl,
    // Stands in for the browser: the user approves, and the Library redirects to the loopback receiver.
    openUrl: (address) => {
      const authorize = new URL(address);
      const q = authorize.searchParams;
      assert.equal(q.get("scope"), "library:read");
      assert.equal(q.get("code_challenge_method"), "S256");
      assert.match(
        q.get("redirect_uri"),
        /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
      );
      challenges.set("code-1", q.get("code_challenge"));
      const back = new URL(q.get("redirect_uri"));
      back.search = new URLSearchParams(
        options.deny
          ? { error: "access_denied", state: q.get("state") }
          : { code: "code-1", state: q.get("state") },
      );
      fetch(back).catch(() => {});
    },
  });
  return { origin, connection, settings, secrets, saved, seen };
}

function vault({ readOnly = false } = {}) {
  const files = [];
  return {
    files,
    vault: {
      getFiles: () => files,
      createBinary: async (path, data) => {
        if (readOnly) throw new Error("EROFS: read-only file system");
        const file = { path, name: path.split("/").pop(), data };
        files.push(file);
        return file;
      },
    },
    fileManager: {
      getAvailablePathForAttachment: async (name) => `attachments/${name}`,
      generateMarkdownLink: (file, source, subpath, alias) =>
        alias ? `[[${file.path}|${alias}]]` : `[[${file.path}]]`,
    },
  };
}

test("connecting stores only the refresh token, in SecretStorage, under the namespaced ID", async (t) => {
  const { origin, connection, settings, secrets, saved, seen } =
    await library(t);
  await connection.connect(origin);
  assert.deepEqual(seen.registered[0].redirect_uris, [
    "http://127.0.0.1/callback",
  ]);
  assert.equal(seen.registered[0].token_endpoint_auth_method, "none");
  assert.equal(settings.serverId, "server-1");
  assert.equal(settings.accountId, USER);
  assert.deepEqual(
    [...secrets],
    [[secretId(settings.vaultKey, "server-1", USER), "refresh-1"]],
  );
  assert.ok(
    saved.length > 0 && saved.every((json) => !/access-|refresh-/.test(json)),
    "data.json holds no tokens",
  );
  assert.equal(connection.connected, true);
  await assert.rejects(connection.connect(origin), {
    code: "disconnect_first",
  });
});

test("a denied consent leaves nothing behind", async (t) => {
  const { origin, connection, secrets } = await library(t, { deny: true });
  await assert.rejects(connection.connect(origin), { code: "denied" });
  assert.equal(secrets.size, 0);
  assert.equal(connection.connected, false);
});

test("browsing lists readable albums and images only", async (t) => {
  const { origin, connection } = await library(t);
  await connection.connect(origin);
  assert.deepEqual(
    (await connection.albums()).map((album) => album.name),
    ["Trips"],
  );
  assert.deepEqual(
    (await connection.search("lake", "", 1)).items.map((asset) => asset.id),
    [ASSET.id],
  );
});

test("inserting saves one local attachment per revision and reuses it", async (t) => {
  const { origin, connection, seen } = await library(t);
  await connection.connect(origin);
  const app = vault();
  const first = await saveAttachment(
    app,
    connection,
    ASSET,
    "Notes/Trip.md",
    true,
  );
  assert.match(first.file.path, /^attachments\/frameleaf-.*-preview\.jpg$/);
  assert.deepEqual(Buffer.from(first.file.data), JPEG);
  assert.equal(
    first.text,
    `![[${first.file.path}|Lake 300]]\n[View in Frameleaf](<${origin}/photos/${ASSET.id}>)`,
  );
  const again = await saveAttachment(app, connection, ASSET, "Other.md", false);
  assert.equal(again.file, first.file);
  assert.equal(app.files.length, 1);
  assert.equal(seen.renditions, 1, "duplicates are not downloaded again");
  await saveAttachment(
    app,
    connection,
    { ...ASSET, updatedAt: "2026-11-05T00:00:00.000Z" },
    "Notes/Trip.md",
    false,
  );
  assert.equal(app.files.length, 2, "an edited photo is a new revision");
});

test("a read-only vault reports the failure and writes nothing", async (t) => {
  const { origin, connection } = await library(t);
  await connection.connect(origin);
  const app = vault({ readOnly: true });
  await assert.rejects(
    saveAttachment(app, connection, ASSET, "Note.md", false),
    { code: "save_failed" },
  );
  assert.equal(app.files.length, 0);
});

test("an interrupted download writes nothing", async (t) => {
  const { origin, connection } = await library(t, { interrupt: true });
  await connection.connect(origin);
  const app = vault();
  await assert.rejects(
    saveAttachment(app, connection, ASSET, "Note.md", false),
    { code: "connection_failed" },
  );
  assert.equal(app.files.length, 0);
});

test("concurrent requests share one refresh, and the rotated token is persisted", async (t) => {
  const { origin, connection, settings, secrets, seen } = await library(t, {
    expiresIn: 10,
  });
  await connection.connect(origin);
  await Promise.all([
    connection.albums(),
    connection.albums(),
    connection.albums(),
  ]);
  assert.equal(seen.refreshes, 1);
  assert.equal(
    secrets.get(
      secretId(settings.vaultKey, settings.serverId, settings.accountId),
    ),
    "refresh-2",
  );
});

test("a refused refresh forgets the token and asks to reconnect", async (t) => {
  const { origin, connection, secrets } = await library(t, {
    expiresIn: 10,
    refuseRefresh: true,
  });
  await connection.connect(origin);
  await assert.rejects(connection.albums(), { code: "reconnect" });
  assert.equal([...secrets.values()].join(""), "");
  assert.equal(connection.connected, false);
});

test("disconnecting revokes the grant and clears the secret", async (t) => {
  const { origin, connection, secrets, seen } = await library(t);
  await connection.connect(origin);
  assert.equal(await connection.disconnect(), true);
  assert.deepEqual(seen.revoked, ["refresh-1"]);
  assert.equal([...secrets.values()].join(""), "");
  assert.equal(connection.connected, false);
});

test("a stored App ID from another Library is not reused", async (t) => {
  const { origin, connection, settings, seen } = await library(t);
  Object.assign(settings, {
    origin: "https://old.example.com",
    clientId: "old-client",
  });
  await connection.connect(origin, undefined);
  assert.equal(seen.registered.length, 1);
  assert.equal(settings.clientId, "client-1");
});

test("disconnecting during a refresh leaves no live token behind", async (t) => {
  const { origin, connection, secrets, seen } = await library(t, {
    expiresIn: 10,
  });
  await connection.connect(origin);
  const browsing = connection.albums().catch(() => {});
  assert.equal(await connection.disconnect(), true);
  await browsing;
  assert.equal([...secrets.values()].join(""), "");
  assert.deepEqual(seen.revoked, ["refresh-2"]);
  assert.equal(connection.connected, false);
});

test("concurrent inserts share one download but each note gets its own link", async (t) => {
  const { origin, connection, seen } = await library(t);
  await connection.connect(origin);
  const app = vault();
  const sources = [];
  const link = app.fileManager.generateMarkdownLink;
  app.fileManager.generateMarkdownLink = (file, source, ...rest) => (
    sources.push(source),
    link(file, source, ...rest)
  );
  const shared = new Map();
  const [a, b] = await Promise.all([
    saveAttachment(app, connection, ASSET, "A/x.md", true, shared),
    saveAttachment(app, connection, ASSET, "B/y.md", false, shared),
  ]);
  assert.equal(seen.renditions, 1);
  assert.equal(app.files.length, 1);
  assert.equal(a.file, b.file);
  assert.deepEqual(sources, ["A/x.md", "B/y.md"]);
  assert.match(a.text, /View in Frameleaf/);
  assert.doesNotMatch(b.text, /View in Frameleaf/);
  assert.equal(shared.size, 0);
});
