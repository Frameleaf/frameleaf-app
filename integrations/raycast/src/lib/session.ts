import { Cache, environment, getPreferenceValues, LocalStorage, OAuth } from "@raycast/api";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ConnectApi,
  ConnectError,
  discover,
  DOWNLOAD_SCOPE,
  exchange,
  fail,
  libraryOrigin,
  READ_SCOPE,
  register,
  revoke,
  withLock,
  type Endpoints,
  type Tokens,
} from "./connect.ts";

type Preferences = { libraryUrl?: string; clientId?: string; allowOriginals?: boolean };

/**
 * Non-secret connection facts. Tokens live only in Raycast's encrypted OAuth token store.
 * `registered` marks a client ID this extension registered itself (safe to forget and register again).
 */
type Connection = { origin: string; clientId?: string; registered?: boolean; serverId?: string; spent?: string };
const CONNECTION = "connection";

export const tempDir = (name: "previews" | "clipboard") => join(environment.supportPath, name);

async function savedConnection(): Promise<Connection | undefined> {
  const raw = await LocalStorage.getItem<string>(CONNECTION);
  return raw ? (JSON.parse(raw) as Connection) : undefined;
}

async function readConnection(origin: string): Promise<Connection> {
  const saved = await savedConnection();
  return saved?.origin === origin ? saved : { origin };
}

const writeConnection = (connection: Connection) => LocalStorage.setItem(CONNECTION, JSON.stringify(connection));

function oauthClient(endpoints?: Endpoints) {
  return new OAuth.PKCEClient({
    redirectMethod: OAuth.RedirectMethod.Web,
    providerName: "Frameleaf",
    providerIcon: "extension-icon.png",
    description: "Connect Raycast to your Library. You choose which albums it can read.",
    // Raycast's own logout revokes only over HTTPS; plain-HTTP LAN Libraries use Disconnect Library.
    revocationEndpoint: endpoints?.revoke.startsWith("https:") ? endpoints.revoke : undefined,
  });
}

let endpointsPromise: Promise<Endpoints> | undefined;
const endpointsFor = (origin: string) =>
  (endpointsPromise ??= discover(fetch, origin).catch((error) => {
    endpointsPromise = undefined;
    throw error;
  }));

async function saveTokens(client: OAuth.PKCEClient, tokens: Tokens) {
  await client.setTokens({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    scope: tokens.scope,
  });
}

/** Forget tokens without Raycast's background revocation, which would send them to the saved endpoint. */
async function dropTokensQuietly() {
  const client = oauthClient();
  if (!(await client.getTokens())) return;
  await client.setTokens({ accessToken: "-" }); // replaces the stored set, and its revocation endpoint
  await client.removeTokens();
}

/** Revokes the grant at its Library (a spent refresh token is accepted too), then forgets the tokens. */
async function revokeAndForget(connection: Connection) {
  const saved = await oauthClient().getTokens();
  if (saved && connection.clientId) {
    const endpoints = await endpointsFor(connection.origin);
    const token = connection.spent ?? saved.refreshToken ?? saved.accessToken;
    await revoke(fetch, endpoints.revoke, connection.clientId, token);
  }
  await dropTokensQuietly();
}

/** A dynamically registered client that failed is forgotten, so the next sign-in registers a fresh one. */
const withoutDeadClient = (connection: Connection): Connection =>
  connection.registered ? { ...connection, clientId: undefined, registered: undefined } : connection;

async function authorize(origin: string, endpoints: Endpoints, preferences: Preferences): Promise<string> {
  const client = oauthClient(endpoints);
  const connection = await readConnection(origin);
  const preset = preferences.clientId?.trim();
  const clientId = preset || connection.clientId || (await register(fetch, endpoints));
  const next: Connection = {
    ...connection,
    clientId,
    registered: preset ? undefined : connection.registered || !connection.clientId,
    spent: undefined,
  };
  await writeConnection(next);

  const request = await client.authorizationRequest({
    endpoint: endpoints.authorize,
    clientId,
    scope: preferences.allowOriginals ? `${READ_SCOPE} ${DOWNLOAD_SCOPE}` : READ_SCOPE,
    extraParameters: { resource: endpoints.resource },
  });
  let code: string;
  try {
    ({ authorizationCode: code } = await client.authorize(request));
  } catch {
    // A deleted registration leaves the browser on the Library's error page and never returns here.
    await writeConnection(withoutDeadClient(next));
    throw fail("declined");
  }
  const tokens = await exchange(fetch, endpoints, {
    grant_type: "authorization_code",
    code,
    code_verifier: request.codeVerifier,
    redirect_uri: request.redirectURI,
    client_id: clientId,
  });
  if ("error" in tokens) {
    await writeConnection(withoutDeadClient(next));
    throw fail("declined");
  }
  await saveTokens(client, tokens);
  return tokens.accessToken;
}

/** An access token for the Library, refreshing or connecting as needed. Refresh is serialized across commands. */
async function token(origin: string, preferences: Preferences, rejected?: string): Promise<string> {
  const endpoints = await endpointsFor(origin);
  const client = oauthClient(endpoints);

  const fresh = await withLock(environment.supportPath, async () => {
    const connection = await readConnection(origin);
    const saved = await client.getTokens();
    if (saved && !connection.clientId) {
      // Tokens from another address, or a store without our records: never send them here.
      await dropTokensQuietly();
      return undefined;
    }
    if (!saved) return undefined;
    if (saved.accessToken !== rejected && !saved.isExpired()) return saved.accessToken;

    if (!saved.refreshToken || saved.refreshToken === connection.spent) {
      // That refresh token was sent and its answer lost. Sending it again would revoke the grant, so
      // revoke it explicitly (the Library accepts a spent token) and connect again.
      await revokeAndForget(connection).catch(dropTokensQuietly);
      await writeConnection({ ...connection, spent: undefined });
      return undefined;
    }
    // Never send the same refresh token twice: record it as spent before sending.
    await writeConnection({ ...connection, spent: saved.refreshToken });
    let tokens: Awaited<ReturnType<typeof exchange>>;
    try {
      tokens = await exchange(fetch, endpoints, {
        grant_type: "refresh_token",
        refresh_token: saved.refreshToken,
        client_id: connection.clientId!, // the client these tokens were issued to
      });
    } catch (error) {
      // An error status means the Library didn't rotate the token, so it may be sent again later.
      // Only a lost or unusable answer leaves it spent.
      if (error instanceof ConnectError && error.kind !== "offline" && error.kind !== "protocol") {
        await writeConnection({ ...connection, spent: undefined });
      }
      throw error;
    }
    if ("error" in tokens) {
      // The grant was revoked, or the app registration removed.
      await dropTokensQuietly();
      await writeConnection({ ...withoutDeadClient(connection), spent: undefined });
      throw fail("revoked");
    }
    await saveTokens(client, tokens);
    await writeConnection({ ...connection, spent: undefined });
    return tokens.accessToken;
  });
  if (fresh) return fresh;
  if (rejected) throw fail("revoked");
  return authorize(origin, endpoints, preferences);
}

export type Session = {
  api: ConnectApi;
  /** Original downloads are opted into, consented to and permitted by the Library. */
  originalsAllowed: boolean;
  /** Opted into originals after connecting: consent again to add them. */
  originalsNeedConsent: boolean;
  libraryName: string;
};

/** Connects (if needed) and checks the Library is the one this extension first connected to. */
export async function openSession(): Promise<Session> {
  const preferences = getPreferenceValues<Preferences>();
  const origin = libraryOrigin(preferences.libraryUrl);
  const api = new ConnectApi(origin, (rejected) => token(origin, preferences, rejected));
  const { serverId } = await endpointsFor(origin);
  const pinned = (await readConnection(origin)).serverId;
  const mismatch = async () => {
    await dropTokensQuietly(); // never send this server a token, not even to revoke it
    throw fail("identity");
  };
  // Checked before any token is sent. Libraries older than discovery's server ID are checked below,
  // after the first authenticated request.
  if (pinned && serverId && serverId !== pinned) await mismatch();
  let capabilities = await api.capabilities();
  const connection = await readConnection(origin);
  if (
    (connection.serverId && connection.serverId !== capabilities.server.id) ||
    (serverId && serverId !== capabilities.server.id)
  ) {
    await mismatch();
  }
  if (!connection.serverId) await writeConnection({ ...connection, serverId: capabilities.server.id });

  if (!preferences.allowOriginals && capabilities.scopes.includes(DOWNLOAD_SCOPE)) {
    // Originals were turned off: a refresh can't narrow a grant, so replace it with a read-only one.
    await revokeAndForget(await readConnection(origin));
    capabilities = await api.capabilities();
  }
  return {
    api,
    originalsAllowed:
      !!preferences.allowOriginals &&
      capabilities.limits.originalsAllowed &&
      capabilities.scopes.includes(DOWNLOAD_SCOPE),
    originalsNeedConsent: !!preferences.allowOriginals && !capabilities.scopes.includes(DOWNLOAD_SCOPE),
    libraryName: capabilities.server.name,
  };
}

async function clearLocalData() {
  new Cache().clear();
  await Promise.all(
    ["previews", "clipboard"].map((name) => rm(join(environment.supportPath, name), { recursive: true, force: true })),
  );
}

/**
 * Revokes the grant at the Library, then forgets tokens, cached results and temporary files. If the
 * Library can't be reached, nothing is forgotten (so a later attempt can still revoke) and this throws.
 */
export async function disconnect(): Promise<void> {
  const connection = await savedConnection();
  if (connection) {
    await revokeAndForget(connection);
    // Keep only the public registration, so reconnecting doesn't register another app.
    await writeConnection({
      origin: connection.origin,
      clientId: connection.clientId,
      registered: connection.registered,
    });
  } else {
    await dropTokensQuietly();
  }
  await clearLocalData();
}

/**
 * Forget a broken sign-in so the next request connects again. `forgetLibrary` also drops the pinned
 * Library identity, registration and cached results, after the person chose to trust a different Library.
 */
export async function forgetSignIn(forgetLibrary = false) {
  const connection = await savedConnection();
  if (forgetLibrary || !connection?.clientId) {
    await dropTokensQuietly();
    await LocalStorage.removeItem(CONNECTION);
    await clearLocalData();
  } else {
    await oauthClient().removeTokens();
    await writeConnection({ ...connection, spent: undefined });
  }
}
