// Frameleaf Connect protocol 1 client. No Raycast imports, so `node --test` can exercise it.
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const RESOURCE_PATH = "/api/connect";
export const READ_SCOPE = "library:read";
export const DOWNLOAD_SCOPE = "library:download"; // originals: only when the person opts in
const ALLOWED_SCOPES = [READ_SCOPE, DOWNLOAD_SCOPE];
// Raycast's static web redirect for every extension. Libraries must register it exactly.
export const RAYCAST_REDIRECT = "https://raycast.com/redirect?packageName=Extension";

export type ErrorKind =
  | "address" // the Library address preference is not usable
  | "offline" // the Library could not be reached
  | "metadata" // the address answered, but not as a Frameleaf Library
  | "registration" // the Library doesn't let apps register; an administrator must
  | "declined" // the person declined, or the sign-in didn't complete
  | "revoked" // the grant is gone; reconnect
  | "identity" // the address now answers as a different Library
  | "forbidden" // access was narrowed or that action isn't allowed
  | "missing" // the photo or rendition is unavailable
  | "busy" // the Library asked to retry shortly
  | "server";

export class ConnectError extends Error {
  kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const MESSAGES: Record<ErrorKind, string> = {
  address: "Enter your Library address in the extension preferences: HTTPS, or HTTP on your own network.",
  offline: "Can’t reach your Library. Check your connection and try again.",
  metadata: "That address didn’t answer as a Frameleaf Library.",
  registration:
    "Your Library doesn’t let apps register themselves. Ask its administrator for a Client ID and add it in the extension preferences.",
  declined: "Sign-in didn’t complete. Connect again to choose the albums Raycast can read.",
  revoked: "Raycast is no longer connected to your Library. Connect again to continue.",
  identity: "This address now belongs to a different Library. Connect again only if you trust it.",
  forbidden: "Raycast doesn’t have access to that. You can change what it can read in your Library’s settings.",
  missing: "That photo is no longer available.",
  busy: "Your Library is busy. Try again in a moment.",
  server: "Your Library couldn’t complete the request.",
};

export const fail = (kind: ErrorKind): ConnectError => new ConnectError(kind, MESSAGES[kind]);

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** Loopback, RFC 1918 IPv4, or a local-only name: where plain HTTP to a home Library is a deliberate choice. */
export function isPrivateHost(hostname: string): boolean {
  if (LOOPBACK.has(hostname) || /\.(local|lan|home\.arpa)$/i.test(hostname)) return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The Library origin from the address preference: HTTPS, or plain HTTP only on a private network. */
export function libraryOrigin(address: string | undefined): string {
  const value = address?.trim() ?? "";
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (
    !url ||
    !(url.protocol === "https:" || (url.protocol === "http:" && isPrivateHost(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", ""].includes(url.pathname)
  ) {
    throw fail("address");
  }
  return url.origin;
}

export type Fetch = typeof fetch;

async function request(fetchImpl: Fetch, url: string | URL, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(20_000) });
  } catch {
    throw fail("offline");
  }
}

async function json(response: Response): Promise<Record<string, unknown> | undefined> {
  const data: unknown = await response.json().catch(() => undefined);
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
}

export type Endpoints = {
  resource: string;
  authorize: string;
  token: string;
  revoke: string;
  register?: string;
};

function sameOrigin(origin: string, value: unknown): string {
  const url = typeof value === "string" && URL.canParse(value) ? new URL(value) : undefined;
  if (url?.origin !== origin || url.username || url.password || url.hash) {
    throw fail("metadata");
  }
  return url.href;
}

/** RFC 9728 + RFC 8414 discovery, pinned to the configured origin. */
export async function discover(fetchImpl: Fetch, origin: string): Promise<Endpoints> {
  const resource = origin + RESOURCE_PATH;
  const protectedResource = await json(
    await request(fetchImpl, `${origin}/.well-known/oauth-protected-resource${RESOURCE_PATH}`),
  );
  const servers = protectedResource?.authorization_servers;
  const scopes = protectedResource?.scopes_supported;
  if (
    protectedResource?.resource !== resource ||
    !Array.isArray(servers) ||
    servers.length !== 1 ||
    servers[0] !== origin ||
    !Array.isArray(scopes) ||
    !scopes.includes(READ_SCOPE)
  ) {
    throw fail("metadata");
  }
  const server = await json(await request(fetchImpl, `${origin}/.well-known/oauth-authorization-server`));
  const methods = server?.code_challenge_methods_supported;
  if (server?.issuer !== origin || !Array.isArray(methods) || !methods.includes("S256")) {
    throw fail("metadata");
  }
  return {
    resource,
    authorize: sameOrigin(origin, server.authorization_endpoint),
    token: sameOrigin(origin, server.token_endpoint),
    revoke: sameOrigin(origin, server.revocation_endpoint ?? `${origin}/api/oauth/apps/revoke`),
    register: server.registration_endpoint === undefined ? undefined : sameOrigin(origin, server.registration_endpoint),
  };
}

/** RFC 7591 public-client registration for Raycast's web redirect. */
export async function register(fetchImpl: Fetch, endpoints: Endpoints): Promise<string> {
  if (!endpoints.register) {
    throw fail("registration");
  }
  const response = await request(fetchImpl, endpoints.register, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Raycast",
      redirect_uris: [RAYCAST_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: ALLOWED_SCOPES.join(" "),
    }),
  });
  const data = await json(response);
  if (!response.ok || typeof data?.client_id !== "string" || !data.client_id) {
    throw fail(response.status === 403 || response.status === 400 ? "registration" : "server");
  }
  return data.client_id;
}

export type Tokens = { accessToken: string; refreshToken: string; expiresIn: number; scope: string };

/**
 * Token endpoint call. Returns `invalid_grant` / `invalid_client` so the caller can reconnect;
 * anything else unexpected throws.
 */
export async function exchange(
  fetchImpl: Fetch,
  endpoints: Endpoints,
  params: Record<string, string>,
): Promise<Tokens | { error: "invalid_grant" | "invalid_client" }> {
  const response = await request(fetchImpl, endpoints.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, resource: endpoints.resource }),
  });
  const data = await json(response);
  if (!response.ok) {
    if (response.status === 400 && (data?.error === "invalid_grant" || data?.error === "invalid_client")) {
      return { error: data.error };
    }
    throw fail(response.status === 429 || response.status === 503 ? "busy" : "server");
  }
  const scope = typeof data?.scope === "string" ? data.scope.split(" ") : [];
  if (
    typeof data?.token_type !== "string" ||
    data.token_type.toLowerCase() !== "bearer" ||
    typeof data.access_token !== "string" ||
    !data.access_token ||
    typeof data.refresh_token !== "string" ||
    !data.refresh_token ||
    typeof data.expires_in !== "number" ||
    !(data.expires_in > 0) ||
    !scope.includes(READ_SCOPE) ||
    scope.some((value) => !ALLOWED_SCOPES.includes(value))
  ) {
    throw fail("server");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: scope.join(" "),
  };
}

/** RFC 7009 revocation. Unknown tokens succeed too, so only transport failures throw. */
export async function revoke(fetchImpl: Fetch, revokeEndpoint: string, clientId: string, token: string) {
  const response = await request(fetchImpl, revokeEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, token_type_hint: "refresh_token", client_id: clientId }),
  });
  if (!response.ok) {
    throw fail("server");
  }
}

/**
 * Cross-process mutex: Raycast may run several commands at once, and refresh tokens rotate, so
 * only one refresh may be in flight. `mkdir` is atomic; a lock older than `staleMs` is abandoned.
 */
export async function withLock<T>(dir: string, fn: () => Promise<T>, staleMs = 60_000, waitMs = 30_000): Promise<T> {
  const lock = join(dir, "refresh.lock");
  await mkdir(dir, { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > staleMs) {
        await rm(lock, { recursive: true, force: true });
      } else if (Date.now() > deadline) {
        throw fail("busy");
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export type Album = { id: string; name: string; workspace: "photo" | "design" | "both"; canRead: boolean };
export type Asset = {
  id: string;
  type: "IMAGE" | "VIDEO";
  title: string | null;
  description: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  createdAt: string;
  updatedAt: string;
};
export type AssetPage = { items: Asset[]; total: number; page: number; size: number };
export type Capabilities = {
  protocolVersion: number;
  server: { id: string; name: string };
  scopes: string[];
  limits: { originalsAllowed: boolean };
};
export type Variant = "thumbnail" | "preview" | "display" | "original";
export type Search = { q?: string; albumId?: string; type?: "IMAGE" | "VIDEO"; page?: number; size?: number };

/** Gives a bearer token; when passed the token the Library just rejected, must return a different one or throw. */
export type TokenSource = (rejected?: string) => Promise<string>;

export class ConnectApi {
  origin: string;
  #token: TokenSource;
  #fetch: Fetch;

  constructor(origin: string, token: TokenSource, fetchImpl: Fetch = fetch) {
    this.origin = origin;
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async #send(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.origin}${RESOURCE_PATH}/${path}`;
    const send = (token: string) =>
      request(this.#fetch, url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    const first = await this.#token();
    let response = await send(first);
    if (response.status === 401) {
      // An expired access token gets one refresh; a second 401 means the grant is gone.
      response = await send(await this.#token(first));
    }
    if (response.ok) return response;
    await response.body?.cancel();
    throw fail(
      response.status === 401
        ? "revoked"
        : response.status === 403
          ? "forbidden"
          : response.status === 404
            ? "missing"
            : response.status === 409 || response.status === 429 || response.status === 503
              ? "busy"
              : "server",
    );
  }

  async #json<T>(path: string): Promise<T> {
    const data = await json(await this.#send(path));
    if (!data) throw fail("server");
    return data as T;
  }

  capabilities() {
    return this.#json<Capabilities>("capabilities");
  }

  async albums(): Promise<Album[]> {
    const { items } = await this.#json<{ items: Album[] }>("albums");
    return items.filter((album) => album.canRead);
  }

  assets(search: Search): Promise<AssetPage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    return this.#json<AssetPage>(`assets?${params}`);
  }

  /** The rendition bytes and their type. Originals need `library:download` and the Library's permission. */
  async rendition(id: string, variant: Variant, signal?: AbortSignal): Promise<{ bytes: Uint8Array; type: string }> {
    const response = await this.#send(
      `assets/${encodeURIComponent(id)}/rendition?variant=${variant}`,
      signal ? { signal } : {},
    );
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    try {
      return { bytes: new Uint8Array(await response.arrayBuffer()), type };
    } catch {
      throw fail("offline");
    }
  }
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/jxl": "jxl",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/** Connect never exposes original filenames, so names come from the capture date and ID. */
export function fileName(asset: Pick<Asset, "id" | "createdAt">, type: string, suffix = ""): string {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(asset.createdAt)?.[0] ?? "photo";
  const id = asset.id.replace(/[^a-f\d]/gi, "").slice(0, 8);
  return `Frameleaf ${date} ${id}${suffix}.${EXTENSIONS[type] ?? "bin"}`;
}

/** Writes bytes into `dir` without overwriting: `name`, then `name (2)`, `name (3)`… Returns the path. */
export async function saveNew(
  dir: string,
  asset: Pick<Asset, "id" | "createdAt">,
  type: string,
  bytes: Uint8Array,
  suffix = "",
): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (let copy = 1; copy < 1000; copy++) {
    const path = join(dir, fileName(asset, type, copy === 1 ? suffix : `${suffix} (${copy})`));
    const partial = `${path}.part`;
    try {
      await writeFile(partial, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    ) {
      await rm(partial, { force: true });
      continue;
    }
    await rename(partial, path);
    return path;
  }
  throw fail("server");
}
