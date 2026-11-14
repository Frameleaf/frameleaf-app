import { environment, getPreferenceValues, LocalStorage, OAuth } from "@raycast/api";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ConnectApi,
  discover,
  exchange,
  fail,
  libraryOrigin,
  register,
  revoke,
  DOWNLOAD_SCOPE,
  READ_SCOPE,
  withLock,
  type Endpoints,
  type Tokens,
} from "./connect.ts";

type Preferences = { libraryUrl?: string; clientId?: string; allowOriginals?: boolean };

/** Non-secret connection facts. Tokens live only in Raycast's encrypted OAuth token store. */
type Connection = { origin: string; clientId?: string; serverId?: string; spent?: string };
const CONNECTION = "connection";

export const tempDir = (name: "previews" | "clipboard") => join(environment.supportPath, name);

async function readConnection(origin: string): Promise<Connection> {
  const raw = await LocalStorage.getItem<string>(CONNECTION);
  const saved = raw ? (JSON.parse(raw) as Connection) : undefined;
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

async function authorize(origin: string, endpoints: Endpoints, preferences: Preferences): Promise<string> {
  const client = oauthClient(endpoints);
  const connection = await readConnection(origin);
  const preset = preferences.clientId?.trim();
  const clientId = preset || connection.clientId || (await register(fetch, endpoints));
  await writeConnection({ ...connection, clientId, spent: undefined });

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
    // A Library reset or an administrator removing the app invalidates a saved registration.
    if (tokens.error === "invalid_client" && !preset) await writeConnection({ ...connection, clientId: undefined });
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
      // Tokens from another address, or a store without our records: start clean.
      await client.removeTokens();
      return undefined;
    }
    if (!saved) return undefined;
    if (saved.accessToken !== rejected && !saved.isExpired()) return saved.accessToken;

    const clientId = connection.clientId!; // the client these tokens were issued to
    if (!saved.refreshToken || saved.refreshToken === connection.spent) {
      // That refresh token was sent and its answer lost. Reuse would revoke the grant; revoking it
      // ourselves (accepted for a spent token) and reconnecting is the same outcome, explicitly.
      await client.removeTokens();
      return undefined;
    }
    // Never send the same refresh token twice: record it as spent before sending.
    await writeConnection({ ...connection, spent: saved.refreshToken });
    const tokens = await exchange(fetch, endpoints, {
      grant_type: "refresh_token",
      refresh_token: saved.refreshToken,
      client_id: clientId,
    });
    if ("error" in tokens) {
      await client.removeTokens();
      await writeConnection({ ...connection, spent: undefined });
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
  const capabilities = await api.capabilities();
  const connection = await readConnection(origin);
  if (connection.serverId && connection.serverId !== capabilities.server.id) {
    throw fail("identity");
  }
  if (!connection.serverId) await writeConnection({ ...connection, serverId: capabilities.server.id });
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

/**
 * Revokes the grant at the Library, then forgets tokens and temporary files. If the Library can't
 * be reached, nothing is forgotten (so a later attempt can still revoke) and this throws.
 */
export async function disconnect(): Promise<void> {
  const raw = await LocalStorage.getItem<string>(CONNECTION);
  const connection = raw ? (JSON.parse(raw) as Connection) : undefined;
  const client = oauthClient();
  const saved = await client.getTokens();
  if (saved && connection?.clientId) {
    const endpoints = await discover(fetch, connection.origin);
    await revoke(fetch, endpoints.revoke, connection.clientId, saved.refreshToken ?? saved.accessToken);
  }
  await client.removeTokens();
  // Keep only the public client registration, so reconnecting doesn't register another app.
  if (connection?.clientId) {
    await writeConnection({ origin: connection.origin, clientId: connection.clientId });
  } else {
    await LocalStorage.removeItem(CONNECTION);
  }
  await Promise.all(
    ["previews", "clipboard"].map((name) => rm(join(environment.supportPath, name), { recursive: true, force: true })),
  );
}

/**
 * Forget a broken sign-in so the next request connects again. `forgetLibrary` also drops the pinned
 * Library identity and its registration, after the person chose to trust a different Library.
 */
export async function forgetSignIn(forgetLibrary = false) {
  await oauthClient().removeTokens();
  const raw = await LocalStorage.getItem<string>(CONNECTION);
  const connection = raw ? (JSON.parse(raw) as Connection) : undefined;
  if (forgetLibrary || !connection?.clientId) {
    await LocalStorage.removeItem(CONNECTION);
  } else {
    await writeConnection({ ...connection, spent: undefined });
  }
}
