import type { ImportConnection, ImportConnectorRepository } from 'src/repositories/import-connector.repository.js';
import {
  type RemoteAccessToken,
  type RemoteSource,
  RemoteSourceAuthError,
  RemoteSourceError,
  type RemoteSourceSession,
  remoteSourceProvider,
} from 'src/import-connectors/remote-source.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { identityDirectory } from 'src/utils/frameleaf-cloud-gateway.js';
import { mailSealKey, openMailSecret, sealMailSecret } from 'src/utils/frameleaf-mail.js';

/**
 * Import connection credentials at rest (FL-920). They are sealed the way a mail connection's refresh
 * token is (AES-256-GCM under a key derived from this server's own key file, bound to the row), with
 * a purpose of their own, so neither opens the other's. The opened value never leaves the server
 * process: it is not part of any answer and is not written to a log.
 */
export const IMPORT_CONNECTION_SEAL_PURPOSE = 'import-connection-seal';

type SealDeps = { crypto: CryptoRepository; config: ConfigRepository };
type OpenDeps = SealDeps & { repository: Pick<ImportConnectorRepository, 'withSealedCredentials' | 'isAdmin'> };

const sealKey = async ({ crypto, config }: SealDeps) =>
  mailSealKey(await crypto.serverKeyedHash(identityDirectory(config), IMPORT_CONNECTION_SEAL_PURPOSE, 'v1'));
const context = (connectionId: string) => `import-connection:${connectionId}`;

export const sealImportCredentials = async (
  deps: SealDeps,
  connectionId: string,
  credentials: Record<string, unknown>,
): Promise<Buffer> => Buffer.from(sealMailSecret(await sealKey(deps), context(connectionId), credentials), 'base64');

/** A connection's credentials, opened. Null when they were sealed by another server's key file or are damaged. */
export const readImportCredentials = async (
  deps: SealDeps,
  connection: Pick<ImportConnection, 'id' | 'sealedCredentials'>,
): Promise<Record<string, unknown> | null> =>
  openMailSecret<Record<string, unknown>>(
    await sealKey(deps),
    context(connection.id),
    connection.sealedCredentials.toString('base64'),
  );

const unreadable = () => new RemoteSourceAuthError('The saved sign-in can no longer be read. Sign in again.');

/**
 * Access tokens by connection and account, in this process only. A source is opened for each batch of
 * files, and Cloud limits token requests per server, so a token that is still good is used again.
 */
const accessTokens = new Map<string, RemoteAccessToken>();

const sharedAccessToken = (key: string): NonNullable<RemoteSourceSession['accessToken']> => ({
  read: () => accessTokens.get(key),
  write: (token) => {
    for (const [other, { expiresAt }] of accessTokens) {
      if (expiresAt <= Date.now()) {
        accessTokens.delete(other);
      }
    }
    accessTokens.set(key, token);
  },
});

/**
 * The hook a source renews its credentials through (FL-959). The row is locked while `renew` runs, so
 * a rotated refresh token is never spent twice, and `renew` always sees the latest one, including one
 * the owner saved by signing in again while this source was reading.
 */
const connectionSession = (
  deps: OpenDeps,
  connection: Pick<ImportConnection, 'id' | 'sealedCredentials'>,
  accountId: unknown,
): RemoteSourceSession => ({
  ...(typeof accountId === 'string' && { accessToken: sharedAccessToken(`${connection.id}:${accountId}`) }),
  renewCredentials: async (renew) => {
    const found = await deps.repository.withSealedCredentials(connection.id, async (sealedCredentials) => {
      const current = await readImportCredentials(deps, { id: connection.id, sealedCredentials });
      if (!current) {
        throw unreadable();
      }
      const next = await renew(current);
      return next ? sealImportCredentials(deps, connection.id, next) : null;
    });
    if (!found) {
      throw new RemoteSourceError('This connection was removed');
    }
  },
});

/** The connection's source, ready to read. Throws `RemoteSourceError` when it cannot be opened here. */
export const openImportConnection = async (
  deps: OpenDeps,
  connection: Pick<ImportConnection, 'id' | 'ownerId' | 'provider' | 'sealedCredentials'>,
): Promise<RemoteSource> => {
  const provider = remoteSourceProvider(connection.provider);
  if (!provider) {
    throw new RemoteSourceError('This kind of connection is not available on this server');
  }
  const credentials = await readImportCredentials(deps, connection);
  if (!credentials) {
    // Another server's key file, or a damaged value: only the owner signing in again mends it.
    throw unreadable();
  }
  // Reaching the home network is an administrator's call, and it lasts only as long as they are one.
  const allowed =
    credentials.allowPrivateAddress === true && !(await deps.repository.isAdmin(connection.ownerId))
      ? { ...credentials, allowPrivateAddress: false }
      : credentials;
  return provider.open(allowed, connectionSession(deps, connection, credentials.accountId));
};

const signInContext = (userId: string) => `import-sign-in:${userId}`;

/**
 * A sign-in in progress, sealed for the browser to hold until it finishes (FL-959). It opens only on
 * this server and only for the account that started it, so the PKCE verifier inside stays here in
 * every sense that matters and no table or settings key is needed for a ten-minute value.
 */
export const sealImportSignIn = async (deps: SealDeps, userId: string, value: unknown): Promise<string> =>
  sealMailSecret(await sealKey(deps), signInContext(userId), value);

export const openImportSignIn = async <T>(deps: SealDeps, userId: string, sealed: string): Promise<T | null> =>
  openMailSecret<T>(await sealKey(deps), signInContext(userId), sealed);
