import type { ImportConnection } from 'src/repositories/import-connector.repository.js';
import {
  type RemoteSource,
  RemoteSourceAuthError,
  RemoteSourceError,
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

const sealKey = async ({ crypto, config }: SealDeps) =>
  mailSealKey(await crypto.serverKeyedHash(identityDirectory(config), IMPORT_CONNECTION_SEAL_PURPOSE, 'v1'));
const context = (connectionId: string) => `import-connection:${connectionId}`;

export const sealImportCredentials = async (
  deps: SealDeps,
  connectionId: string,
  credentials: Record<string, unknown>,
): Promise<Buffer> => Buffer.from(sealMailSecret(await sealKey(deps), context(connectionId), credentials), 'base64');

/** The connection's source, ready to read. Throws `RemoteSourceError` when it cannot be opened here. */
export const openImportConnection = async (
  deps: SealDeps,
  connection: Pick<ImportConnection, 'id' | 'provider' | 'sealedCredentials'>,
): Promise<RemoteSource> => {
  const provider = remoteSourceProvider(connection.provider);
  if (!provider) {
    throw new RemoteSourceError('This kind of connection is not available on this server');
  }
  const credentials = openMailSecret<Record<string, unknown>>(
    await sealKey(deps),
    context(connection.id),
    connection.sealedCredentials.toString('base64'),
  );
  if (!credentials) {
    // Another server's key file, or a damaged value: only the owner signing in again mends it.
    throw new RemoteSourceAuthError('The saved sign-in can no longer be read. Sign in again.');
  }
  return provider.open(credentials);
};
