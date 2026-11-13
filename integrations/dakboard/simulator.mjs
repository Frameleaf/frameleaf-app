import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const JSON_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 16 * 1024 * 1024;
const originOf = (value) => {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new Error(
      "Use a trusted HTTPS Library origin (loopback HTTP is for this simulator only).",
    );
  }
  return url.origin;
};
async function bounded(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Response exceeds the simulator transfer limit.");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > limit)
      throw new Error("Response exceeds the simulator transfer limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}
async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Connect request failed (${response.status}).`);
  }
  return JSON.parse((await bounded(response, JSON_LIMIT)).toString("utf8"));
}

/** Partner protocol simulator: credentials remain in memory and one process owns each connection. */
export class ConnectDisplay {
  #tokens;
  #refresh;
  #disconnect;
  #closing = false;
  #renewalFailed = false;
  #closed = false;
  constructor(origin, clientId) {
    this.origin = originOf(origin);
    this.clientId = clientId;
    this.resource = `${this.origin}/api/connect`;
  }
  acceptTokens(value) {
    if (this.#closed) throw new Error("Connect again.");
    if (
      value.token_type?.toLowerCase() !== "bearer" ||
      typeof value.access_token !== "string" ||
      !value.access_token ||
      typeof value.refresh_token !== "string" ||
      !value.refresh_token ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in < 0
    )
      throw new Error("Invalid OAuth token response.");
    this.#tokens = {
      access: value.access_token,
      refresh: value.refresh_token,
      expires: Date.now() + value.expires_in * 1000,
    };
  }
  async #rotate() {
    if (!this.#tokens || this.#closed || this.#closing || this.#renewalFailed)
      throw new Error("Connect again.");
    if (!this.#refresh) {
      const refreshToken = this.#tokens.refresh;
      this.#refresh = jsonRequest(`${this.origin}/api/oauth/apps/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: this.clientId,
          resource: this.resource,
        }),
      })
        .then((tokens) => this.acceptTokens(tokens))
        .catch(() => {
          this.#renewalFailed = true;
          throw new Error(
            "The connection could not be renewed. Connect again.",
          );
        })
        .finally(() => {
          this.#refresh = undefined;
        });
    }
    await this.#refresh;
  }
  async #request(path, binary = false) {
    if (!this.#tokens || this.#closed || this.#closing || this.#renewalFailed)
      throw new Error("Connect again.");
    if (this.#tokens.expires <= Date.now() + 30_000) await this.#rotate();
    if (!this.#tokens || this.#closed || this.#closing)
      throw new Error("Connect again.");
    const access = this.#tokens.access;
    const send = () =>
      fetch(`${this.resource}${path}`, {
        headers: { Authorization: `Bearer ${this.#tokens.access}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      if (this.#tokens?.access === access) await this.#rotate();
      if (!this.#tokens || this.#closed || this.#closing)
        throw new Error("Connect again.");
      response = await send();
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) this.#tokens = undefined;
      const retry = response.headers.get("retry-after");
      throw new Error(
        `Connect request failed (${response.status})${response.status === 429 && /^\d+$/.test(retry ?? "") ? `; retry after ${retry} seconds` : ""}.`,
      );
    }
    if (
      binary &&
      response.headers.get("content-type")?.split(";")[0] !== "image/jpeg"
    ) {
      await response.body?.cancel();
      throw new Error("The display requires a JPEG rendition.");
    }
    const bytes = await bounded(response, binary ? IMAGE_LIMIT : JSON_LIMIT);
    return binary ? bytes : JSON.parse(bytes.toString("utf8"));
  }
  capabilities() {
    return this.#request("/capabilities");
  }
  albums() {
    return this.#request("/albums");
  }
  photos(albumId, page = 1) {
    if (!Number.isSafeInteger(page) || page < 1)
      throw new Error("Invalid page.");
    return this.#request(
      `/assets?${new URLSearchParams({ albumId, type: "IMAGE", page: String(page), size: "100" })}`,
    );
  }
  async prefetch(ids) {
    if (!Array.isArray(ids) || ids.length > 2)
      throw new Error("Only prefetch the current and next image.");
    return Promise.all(
      ids.map((id) =>
        this.#request(
          `/assets/${encodeURIComponent(id)}/rendition?variant=display`,
          true,
        ),
      ),
    );
  }
  async disconnect() {
    if (this.#closed) return;
    this.#closing = true;
    if (!this.#disconnect) {
      this.#disconnect = (async () => {
        // Revocation accepts our last stored token even when its rotation response was lost.
        await this.#refresh?.catch(() => {});
        const token = this.#tokens?.refresh;
        if (token)
          await jsonRequest(`${this.origin}/api/oauth/apps/revoke`, {
            method: "POST",
            body: new URLSearchParams({
              token,
              token_type_hint: "refresh_token",
              client_id: this.clientId,
            }),
          });
        this.#tokens = undefined;
        this.#closed = true;
      })().finally(() => {
        this.#disconnect = undefined;
      });
    }
    await this.#disconnect;
  }
}

export async function connect(origin, clientId, announce = console.log) {
  origin = originOf(origin);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  let resolveCode, rejectCode;
  const code = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const received = Buffer.from(url.searchParams.get("state") ?? "");
    if (
      req.method !== "GET" ||
      url.pathname !== "/callback" ||
      received.length !== state.length ||
      !timingSafeEqual(received, Buffer.from(state))
    ) {
      res.writeHead(400);
      res.end("Invalid callback.");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Return to the protocol simulator.");
    const value = url.searchParams.get("code");
    if (value && !url.searchParams.has("error")) resolveCode(value);
    else rejectCode(new Error("Consent was denied."));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const timer = setTimeout(
    () => rejectCode(new Error("Connection expired. Start again.")),
    5 * 60_000,
  );
  // Attach a rejection handler before discovery so timeout/denial cannot become unhandled.
  code.catch(() => {});
  try {
    const resource = await jsonRequest(
      `${origin}/.well-known/oauth-protected-resource/api/connect`,
    );
    if (
      resource.resource !== `${origin}/api/connect` ||
      !resource.authorization_servers?.includes(origin)
    )
      throw new Error("Unexpected Connect discovery.");
    const metadata = await jsonRequest(
      `${origin}/.well-known/oauth-authorization-server`,
    );
    for (const field of ["authorization_endpoint", "token_endpoint"]) {
      if (new URL(metadata[field]).origin !== origin)
        throw new Error("Unexpected OAuth endpoint.");
    }
    if (!clientId) {
      if (
        metadata.registration_endpoint !== `${origin}/api/oauth/apps/register`
      )
        throw new Error(
          "Ask the Library administrator to register this simulator callback.",
        );
      const registration = await jsonRequest(metadata.registration_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Frameleaf DAKboard protocol simulator",
          redirect_uris: [redirect],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      clientId = registration.client_id;
    }
    if (typeof clientId !== "string" || !clientId)
      throw new Error("Invalid client registration.");
    const authorization = new URL(metadata.authorization_endpoint);
    authorization.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirect,
      scope: "library:read",
      resource: resource.resource,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    await announce(authorization.href);
    const tokens = await jsonRequest(metadata.token_endpoint, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirect,
        code: await code,
        code_verifier: verifier,
        resource: resource.resource,
      }),
    });
    const display = new ConnectDisplay(origin, clientId);
    display.acceptTokens(tokens);
    return display;
  } finally {
    clearTimeout(timer);
    await new Promise((resolve) => server.close(resolve));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const display = await connect(process.argv[2], process.argv[3]);
    try {
      const { items } = await display.albums();
      console.log(
        `Connection verified; ${items.filter((album) => album.canRead).length} readable albums.`,
      );
    } finally {
      await display.disconnect();
    }
  } catch {
    console.error(
      "Connection failed. Check the Library address, consent and callback registration.",
    );
    process.exitCode = 1;
  }
}
