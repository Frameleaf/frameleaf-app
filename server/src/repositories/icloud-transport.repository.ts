import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { ICloudAuthDto } from 'src/dtos/icloud-sync.dto.js';
import type { ICloudLibrary, ICloudRecord } from 'src/repositories/icloud-sync.repository.js';
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

@Injectable()
export class ICloudTransportRepository {
  enabled(): boolean {
    return !!process.env.IMMICH_ICLOUD_BRIDGE_URL;
  }

  private async configuration() {
    const raw = process.env.IMMICH_ICLOUD_BRIDGE_URL;
    if (!raw) {
      throw new ICloudTransportError('icloud_disabled');
    }
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new ICloudTransportError('icloud_bridge_configuration_invalid');
    }
    const paths = [
      process.env.IMMICH_ICLOUD_KEY_FILE,
      process.env.IMMICH_ICLOUD_BRIDGE_TOKEN_FILE,
      process.env.IMMICH_ICLOUD_CA_FILE,
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

  async encodeSession(connectionId: string, session: unknown): Promise<string> {
    return encryptICloudSession(await this.configuration().then((result) => result.key), connectionId, session);
  }

  async decodeSession(connectionId: string, encrypted: string | null): Promise<unknown> {
    if (!encrypted) {
      throw new ICloudTransportError('reauthentication_required');
    }
    return decryptICloudSession(await this.configuration().then((result) => result.key), connectionId, encrypted);
  }

  private async send(
    endpoint: 'auth' | 'inventory' | 'download',
    body: unknown,
    signal?: AbortSignal,
  ): Promise<IncomingMessage> {
    const { url, token, ca } = await this.configuration();
    const data = Buffer.from(JSON.stringify(body));
    if (data.length > 2 * 1024 ** 2) {
      throw new ICloudTransportError('icloud_request_too_large');
    }
    return new Promise((resolve, reject) => {
      const req = request(
        new URL(`/v1/${endpoint}`, url),
        {
          method: 'POST',
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

  async inventory(input: {
    session: unknown;
    kind: 'libraries' | 'albums' | 'assets' | 'changes' | 'memberships';
    library?: ICloudLibrary;
    albumId?: string;
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
