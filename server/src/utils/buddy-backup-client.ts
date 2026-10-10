import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type z from 'zod';
import { BUDDY_BLOCK_BYTES, BUDDY_SEALED_OVERHEAD } from 'src/utils/buddy-backup-crypto.js';
import { verifyBuddyResponse } from 'src/utils/buddy-backup-protocol.js';
import { BuddyVault } from 'src/utils/buddy-backup-vault.js';
import { advanceExecutionProgress, assertExecutionActive, executionTimeout } from 'src/utils/execution-signal.js';
import { BuddyGrantResponse } from 'src/utils/frameleaf-buddy.js';
import { type FrameleafKeySigner, createDpopProof } from 'src/utils/frameleaf-dpop.js';

export class BuddyPeerUnavailable extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class BuddyExecutionError extends Error {}

/** The same immutable object may resume on a different verified candidate after a route fails. */
export class BuddyBackupClient {
  private nonces = new Map<string, string>();
  connection: string | null = null;

  constructor(
    private grant: () => Promise<z.infer<typeof BuddyGrantResponse>>,
    private signer: () => FrameleafKeySigner,
    private throttle: (bytes: number, direction: 'upload' | 'download') => Promise<void>,
  ) {}

  async request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, block?: Buffer): Promise<T> {
    assertExecutionActive();
    const grant = await this.grant();
    assertExecutionActive();
    let failure: unknown = new BuddyPeerUnavailable(503, 'Buddy is offline');
    for (const candidate of grant.connections) {
      const origin = new URL(candidate.uri);
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) continue;
      const url = new URL(`/api/buddy/v1/vaults/${grant.claims.vaultId}/${path}`, origin).href;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const proof = createDpopProof(this.signer(), {
            htm: method,
            htu: url,
            accessToken: grant.token,
            nonce: this.nonces.get(origin.origin),
          });
          const requestId = (JSON.parse(Buffer.from(proof.split('.', 2)[1], 'base64url').toString()) as { jti: string })
            .jti;
          const headers: Record<string, string> = { Authorization: `DPoP ${grant.token}`, DPoP: proof };
          let payload: string | Readable | undefined;
          if (block) {
            headers['Content-Type'] = 'application/octet-stream';
            headers['Content-Length'] = String(block.length);
            const throttle = this.throttle;
            payload = Readable.from(
              (async function* () {
                for (let offset = 0; offset < block.length; offset += 64 * 1024) {
                  const piece = block.subarray(offset, offset + 64 * 1024);
                  assertExecutionActive();
                  await throttle(piece.length, 'upload');
                  assertExecutionActive();
                  yield piece;
                  advanceExecutionProgress(piece.length);
                }
              })(),
            );
          } else if (body !== undefined) {
            headers['Content-Type'] = 'application/vnd.frameleaf.buddy+json';
            payload = JSON.stringify(body);
          }
          const remaining = grant.claims.exp * 1000 - Date.now();
          if (remaining <= 0) throw new BuddyPeerUnavailable(401, 'Buddy authorization expired');
          const options = {
            method,
            headers,
            body: payload as BodyInit | undefined,
            redirect: 'error' as const,
            signal: executionTimeout(Math.min(remaining, block ? 240_000 : 60_000)),
            ...(block && { duplex: 'half' }),
          };
          let response: Response;
          try {
            response = await fetch(url, options);
          } finally {
            if (payload instanceof Readable) {
              payload.destroy();
              await finished(payload).catch(() => {});
            }
          }
          const nonce = response.headers.get('dpop-nonce');
          if (nonce && /^[\w-]{43}$/.test(nonce)) this.nonces.set(origin.origin, nonce);
          if (response.status === 401 && nonce && attempt === 0) {
            await response.body?.cancel();
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            if (![401, 403, 429, 507].includes(response.status)) throw new BuddyExecutionError('Buddy transfer failed');
            throw new BuddyPeerUnavailable(
              response.status,
              response.status === 507
                ? 'Buddy storage is full'
                : response.status === 401 || response.status === 403
                  ? 'Buddy authorization needs renewal'
                  : 'Buddy transfer is waiting',
            );
          }
          const binary = response.headers.get('content-type')?.startsWith('application/octet-stream');
          const maximum = binary ? BUDDY_BLOCK_BYTES + BUDDY_SEALED_OVERHEAD : 256 * 1024 * 1024;
          const chunks: Buffer[] = [];
          let length = 0;
          if (!response.body) throw new Error('Empty Buddy response');
          for await (const chunk of response.body) {
            length += chunk.length;
            if (length > maximum) throw new Error('Buddy response exceeds the protocol limit');
            if (binary) await this.throttle(chunk.length, 'download');
            assertExecutionActive();
            advanceExecutionProgress(chunk.length);
            chunks.push(Buffer.from(chunk));
          }
          const bytes = Buffer.concat(chunks);
          if (binary) {
            const id = path.split('/').at(-1)!;
            verifyBuddyResponse(
              response.headers.get('buddy-proof') ?? '',
              grant.claims,
              BuddyVault.receipt(id, bytes),
              requestId,
            );
            this.connection = candidate.kind;
            return bytes as T;
          }
          const envelope = JSON.parse(bytes.toString()) as { data: T; proof: string };
          verifyBuddyResponse(envelope.proof, grant.claims, envelope.data, requestId);
          this.connection = candidate.kind;
          return envelope.data;
        }
      } catch (error) {
        assertExecutionActive();
        // Undici can accept response headers before a restarting peer resets its body.
        // Keep transport interruption with the durable worker's existing retry policy;
        // malformed JSON and rejected cryptographic proofs remain protocol failures.
        const cause = error instanceof Error ? error.cause : undefined;
        const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
        failure =
          error instanceof Error &&
          (error.message === 'fetch failed' ||
            ['AbortError', 'TimeoutError'].includes(error.name) ||
            (error instanceof TypeError && ['ECONNRESET', 'UND_ERR_SOCKET'].includes(String(code))))
            ? new BuddyExecutionError(
                'Buddy transfer timed out or lost its connection; the verified checkpoint is preserved',
              )
            : error;
        if (error instanceof BuddyPeerUnavailable && [403, 429, 507].includes(error.status)) throw error;
      }
    }
    throw failure;
  }
}
