import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { type IncomingMessage, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ICloudAuthDto } from 'src/dtos/icloud-sync.dto.js';
import type { ICloudLibrary, ICloudRecord } from 'src/repositories/icloud-sync.repository.js';
import type { ICloudSmartAlbum } from 'src/utils/media-kinds.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { readAliasedEnv } from 'src/utils/env-aliases.js';
import { decryptICloudSession, encryptICloudSession } from 'src/utils/icloud-sync.js';

export type ICloudPage = {
  version: 1;
  session: unknown;
  records: ICloudRecord[];
  nextCursor?: unknown;
  complete: boolean;
  capabilities: Record<string, unknown>;
};
export class ICloudTransportError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const BUNDLED_BRIDGE = '/usr/local/bin/icloud-bridge';

/** Server-owned home for the bundled bridge's secrets and staging; nothing here is user-configured. */
export const bundledICloudDirectory = () => {
  const media = resolve(StorageCore.getMediaLocation());
  return join(existsSync(media) ? realpathSync(media) : media, '.frameleaf-icloud');
};

/** Reads a generated secret, creating it atomically so API and worker processes agree on one value. */
const readOrCreateSecret = async (path: string, bytes: number, encoding: 'base64' | 'hex') => {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, randomBytes(bytes).toString(encoding), { mode: 0o600 });
  try {
    await link(temporary, path).catch((error) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return readFile(path);
};

const freeLoopbackPort = () =>
  new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });

@Injectable()
export class ICloudTransportRepository {
  // Static: weeklyIdentityAdoptionActive builds its own instance and must see the same answer.
  private static switchedOn = true;
  private bundledBridge?: Promise<URL>;
  private bundledChild?: ChildProcess;
  private readonly sessionCrypto = new AsyncLocalStorage<{ key: Buffer } | { error: unknown }>();

  /** Capture configuration before locks; retain failure only if this operation actually needs crypto. */
  async withSessionCrypto<T>(action: () => Promise<T>): Promise<T> {
    if (this.sessionCrypto.getStore()) return action();
    let prepared: { key: Buffer } | { error: unknown };
    try {
      prepared = { key: (await this.configuration()).key };
    } catch (error) {
      prepared = { error };
    }
    return this.sessionCrypto.run(prepared, action);
  }

  private async sessionKey(): Promise<Buffer> {
    const prepared = this.sessionCrypto.getStore();
    if (!prepared) return (await this.configuration()).key;
    if ('error' in prepared) throw prepared.error;
    return prepared.key;
  }

  enabled(): boolean {
    return (
      ICloudTransportRepository.switchedOn &&
      (!!readAliasedEnv('FRAMELEAF_ICLOUD_BRIDGE_URL') || existsSync(BUNDLED_BRIDGE))
    );
  }

  /** The administrator's iCloud Photos switch. Off stops this process's bridge; it restarts on next use once on. */
  setSwitchedOn(on: boolean): void {
    ICloudTransportRepository.switchedOn = on;
    if (!on) {
      this.bundledChild?.kill();
    }
  }

  private async configuration() {
    if (!ICloudTransportRepository.switchedOn) {
      throw new ICloudTransportError('icloud_disabled');
    }
    const raw = readAliasedEnv('FRAMELEAF_ICLOUD_BRIDGE_URL');
    if (!raw) {
      return this.bundledConfiguration();
    }
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new ICloudTransportError('icloud_bridge_configuration_invalid');
    }
    const paths = [
      readAliasedEnv('FRAMELEAF_ICLOUD_KEY_FILE'),
      readAliasedEnv('FRAMELEAF_ICLOUD_BRIDGE_TOKEN_FILE'),
      readAliasedEnv('FRAMELEAF_ICLOUD_CA_FILE'),
    ];
    if (paths.some((value) => !value)) {
      throw new ICloudTransportError('icloud_secrets_not_configured');
    }
    const [keyFile, tokenFile, ca] = await Promise.all(paths.map((value) => readFile(value!)));
    const key = Buffer.from(keyFile.toString().trim(), 'base64');
    const token = tokenFile.toString().trim();
    if (key.length !== 32 || token.length < 32 || /[\r\n]/.test(token)) {
      throw new ICloudTransportError('icloud_secrets_invalid');
    }
    return { url, key, token, ca };
  }

  private async bundledConfiguration() {
    if (!existsSync(BUNDLED_BRIDGE)) {
      throw new ICloudTransportError('icloud_disabled');
    }
    const directory = bundledICloudDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tokenPath = join(directory, 'bridge-token');
    const [keyFile, tokenFile] = await Promise.all([
      readOrCreateSecret(join(directory, 'encryption-key'), 32, 'base64'),
      readOrCreateSecret(tokenPath, 32, 'hex'),
    ]);
    const token = tokenFile.toString().trim();
    const url = await (this.bundledBridge ??= this.startBundledBridge(tokenPath, token).catch((error) => {
      this.bundledBridge = undefined;
      throw error;
    }));
    return { url, key: Buffer.from(keyFile.toString().trim(), 'base64'), token };
  }

  // ponytail: one bridge per server process; the bridge keeps no sync state, so API and worker need not share.
  private async startBundledBridge(tokenPath: string, token: string): Promise<URL> {
    const port = await freeLoopbackPort();
    // Only these variables: the child must not inherit database or other server secrets.
    const child = spawn(BUNDLED_BRIDGE, [], {
      stdio: 'ignore',
      env: {
        ICLOUD_BRIDGE_LISTEN: `127.0.0.1:${port}`,
        ICLOUD_BRIDGE_TOKEN_FILE: tokenPath,
        ICLOUD_BRIDGE_ALLOW_LOOPBACK_HTTP: 'true',
      },
    });
    this.bundledChild = child;
    const stop = () => child.kill();
    process.once('exit', stop);
    let running = true;
    const onGone = () => {
      running = false;
      this.bundledBridge = undefined;
      this.bundledChild = undefined;
      process.removeListener('exit', stop);
    };
    child.once('error', onGone);
    child.once('exit', onGone);

    const url = new URL(`http://127.0.0.1:${port}/`);
    for (let attempt = 0; attempt < 50 && running; attempt++) {
      const ready = await fetch(new URL('/health', url), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1000),
      })
        .then((response) => response.ok)
        .catch(() => false);
      if (ready) {
        return url;
      }
      await sleep(100);
    }
    child.kill();
    throw new ICloudTransportError('icloud_transport_failed');
  }

  async encodeSession(connectionId: string, session: unknown): Promise<string> {
    return encryptICloudSession(await this.sessionKey(), connectionId, session);
  }

  async decodeSession(connectionId: string, encrypted: string | null): Promise<unknown> {
    if (!encrypted) {
      throw new ICloudTransportError('reauthentication_required');
    }
    return decryptICloudSession(await this.sessionKey(), connectionId, encrypted);
  }

  private async send(
    endpoint: 'auth' | 'inventory' | 'download' | 'capabilities',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<IncomingMessage> {
    const configuration = await this.configuration();
    const { url, token } = configuration;
    const ca = 'ca' in configuration ? configuration.ca : undefined;
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    // capabilities is the one read without a body
    const method = endpoint === 'capabilities' ? 'GET' : 'POST';
    const data = Buffer.from(method === 'GET' ? '' : JSON.stringify(body));
    if (data.length > 2 * 1024 ** 2) {
      throw new ICloudTransportError('icloud_request_too_large');
    }
    return new Promise((resolve, reject) => {
      const req = request(
        new URL(`/v1/${endpoint}`, url),
        {
          method,
          ca,
          signal,
          maxHeaderSize: 1024 ** 2,
          timeout: 60_000,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': data.length,
          },
        },
        (res) => {
          res.setTimeout(60_000, () => res.destroy(new ICloudTransportError('icloud_transport_timeout')));
          if (res.statusCode === 200) {
            resolve(res);
            return;
          }
          void this.readJson(res)
            .then((value) => {
              const code = (value as { error?: { code?: string } }).error?.code;
              const safe = [
                'reauthentication_required',
                'device_approval_required',
                'resource_changed',
                'invalid_change_token',
                'rate_limited',
                'unsupported',
                'invalid_request',
              ];
              reject(new ICloudTransportError(code && safe.includes(code) ? code : 'icloud_transport_failed'));
            })
            .catch(() => reject(new ICloudTransportError('icloud_transport_failed')));
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () =>
        reject(new ICloudTransportError(signal?.aborted ? 'icloud_cancelled' : 'icloud_transport_failed')),
      );
      req.end(data);
    });
  }

  private async readJson(stream: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 16 * 1024 ** 2) {
        stream.destroy();
        throw new ICloudTransportError('icloud_response_too_large');
      }
      chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new ICloudTransportError('icloud_response_invalid');
    }
  }

  async authenticate(dto: ICloudAuthDto, session?: unknown): Promise<{ state: string; session: unknown }> {
    const value = await this.readJson(await this.send('auth', { ...dto, session }));
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      value.version !== 1 ||
      !('state' in value) ||
      !('session' in value) ||
      typeof value.state !== 'string' ||
      !['connected', 'awaiting-2fa', 'awaiting-device-approval', 'reauthentication-required'].includes(value.state) ||
      !value.session ||
      typeof value.session !== 'object' ||
      !('version' in value.session) ||
      value.session.version !== 1
    ) {
      throw new ICloudTransportError('icloud_response_invalid');
    }
    return { state: value.state, session: value.session };
  }

  /** FL-1289: what the bridge supports (`GET /v1/capabilities`), e.g. `smartAlbums`. */
  async capabilities(): Promise<Record<string, unknown>> {
    const value = await this.readJson(await this.send('capabilities'));
    const capabilities = value && typeof value === 'object' ? (value as { capabilities?: unknown }).capabilities : null;
    if (!capabilities || typeof capabilities !== 'object') {
      throw new ICloudTransportError('icloud_response_invalid');
    }
    return capabilities as Record<string, unknown>;
  }

  async inventory(input: {
    session: unknown;
    kind: 'libraries' | 'albums' | 'assets' | 'changes' | 'memberships';
    library?: ICloudLibrary;
    albumId?: string;
    /** FL-1289: with kind `assets`, one of iCloud's Media Types smart albums instead of the library. */
    smartAlbum?: ICloudSmartAlbum;
    cursor?: unknown;
  }): Promise<ICloudPage> {
    const value = await this.readJson(await this.send('inventory', { ...input, limit: 100 }));
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      value.version !== 1 ||
      !('session' in value) ||
      !value.session ||
      typeof value.session !== 'object' ||
      !('version' in value.session) ||
      value.session.version !== 1 ||
      !('records' in value) ||
      !Array.isArray(value.records) ||
      value.records.length > 1000 ||
      !('complete' in value) ||
      typeof value.complete !== 'boolean'
    ) {
      throw new ICloudTransportError('icloud_response_invalid');
    }
    return value as ICloudPage;
  }

  async download(
    input: {
      session: unknown;
      library: ICloudLibrary;
      recordId: string;
      resourceKey: string;
      expectedFingerprint?: string;
    },
    signal?: AbortSignal,
  ) {
    const stream = await this.send('download', input, signal);
    const header = stream.headers['x-icloud-session'];
    const fingerprint = stream.headers['x-icloud-resource-fingerprint'];
    const size = Number(stream.headers['x-icloud-resource-size']);
    if (typeof header !== 'string' || typeof fingerprint !== 'string' || !Number.isSafeInteger(size) || size <= 0) {
      stream.destroy();
      throw new ICloudTransportError('icloud_download_invalid');
    }
    let session: unknown;
    try {
      session = JSON.parse(Buffer.from(header, 'base64url').toString());
    } catch {
      stream.destroy();
      throw new ICloudTransportError('icloud_session_invalid');
    }
    if (!session || typeof session !== 'object' || !('version' in session) || session.version !== 1) {
      stream.destroy();
      throw new ICloudTransportError('icloud_session_invalid');
    }
    return { stream, session, fingerprint, size };
  }
}
