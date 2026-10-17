// FL-408: the bundled Studio worker's side of the render-worker protocol: requests, the claim
// lease, input grants streamed to disk and the artifact upload. Credentials travel only in headers,
// redirects are refused, and nothing here logs a URL, a credential or a graph.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const JSON_LIMIT = 32 * 1024 * 1024;

export class WorkerHttpError extends Error {
  constructor(status) {
    super(`Server answered ${status}`);
    this.name = 'WorkerHttpError';
    this.status = status;
  }
}

/** The server origin, refusing anything with a path, query or embedded credentials. */
export const serverOrigin = (value) => {
  const url = new URL(value);
  assert.ok(
    ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    'Use the server origin without credentials, query or fragment',
  );
  return new URL(url.origin);
};

const readJson = async (response) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= JSON_LIMIT, 'RESPONSE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

export function createWorkerClient({ serverUrl, sessionToken = null, fetchImpl = fetch }) {
  const origin = serverOrigin(serverUrl);
  const headers = (extra = {}) => ({
    ...(sessionToken && { 'x-frameleaf-worker-session': sessionToken }),
    ...extra,
  });
  const request = async (method, pathname, { body, timeoutMs = 15_000, signal, extraHeaders } = {}) => {
    const response = await fetchImpl(new URL(pathname, origin), {
      method,
      headers: headers({
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      }),
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 204) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new WorkerHttpError(response.status);
    }
    return response.body ? readJson(response) : null;
  };
  return {
    origin,
    withSession: (token) => createWorkerClient({ serverUrl, sessionToken: token, fetchImpl }),
    post: (pathname, body, options) => request('POST', pathname, { ...options, body }),

    /**
     * Stream one input grant to `file`, verifying the declared SHA-1/SHA-256 (hex or base64) and the
     * byte budget as the bytes arrive. The grant URL must be this operation's own input path.
     */
    async download(operationId, input, file, { maxBytes, signal }) {
      const prefix = `/api/render-workers/operations/${operationId}/inputs/`;
      assert.ok(
        typeof input.url === 'string' &&
          input.url.startsWith(prefix) &&
          /^[A-Za-z0-9_.-]+$/.test(input.url.slice(prefix.length)),
        'INVALID_INPUT_GRANT_URL',
      );
      const expected = checksumOf(input.checksum);
      const response = await fetchImpl(new URL(input.url, origin), {
        headers: headers(),
        redirect: 'error',
        signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new WorkerHttpError(response.status);
      }
      const sha1 = createHash('sha1');
      const sha256 = createHash('sha256');
      let size = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > maxBytes) {
            callback(new Error('INPUT_LIMIT_EXCEEDED'));
            return;
          }
          sha1.update(chunk);
          sha256.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(file, { flags: 'wx', mode: 0o600 }), {
          signal,
        });
      } catch (error) {
        await rm(file, { force: true });
        throw error;
      }
      const hashes = { sha1: sha1.digest(), sha256: sha256.digest() };
      if (expected && !hashes[expected.algorithm].equals(expected.digest)) {
        await rm(file, { force: true });
        throw new Error('INPUT_CHECKSUM_MISMATCH');
      }
      return { size, sha256: hashes.sha256.toString('hex') };
    },

    /** Upload the encoded export as the whole-export artifact (sequence 0). */
    async uploadArtifact(operationId, claimToken, file, metadata, { signal }) {
      const query = new URLSearchParams(metadata);
      const response = await fetchImpl(
        new URL(`/api/render-workers/operations/${operationId}/artifacts/0?${query}`, origin),
        {
          method: 'PUT',
          headers: headers({
            'x-render-claim-token': claimToken,
            'Content-Type': 'application/octet-stream',
          }),
          body: createReadStream(file),
          duplex: 'half',
          redirect: 'error',
          signal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new WorkerHttpError(response.status);
      }
      return readJson(response);
    },
  };
}

/** A declared checksum: 40/64 hex characters or base64 of a 20/32-byte digest. Null when none. */
export const checksumOf = (checksum) => {
  if (checksum === null || checksum === undefined) return null;
  assert.equal(typeof checksum, 'string', 'INVALID_INPUT_CHECKSUM');
  const hex = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(checksum);
  const digest = Buffer.from(checksum, hex ? 'hex' : 'base64');
  assert.ok(
    [20, 32].includes(digest.length) && (hex || digest.toString('base64') === checksum),
    'INVALID_INPUT_CHECKSUM',
  );
  return { algorithm: digest.length === 20 ? 'sha1' : 'sha256', digest };
};

/**
 * Hold a claim's lease. Heartbeats run on their own timer for the whole attempt, so a long input
 * transfer or render never lets the lease lapse. The returned signal aborts the attempt when the
 * lease is lost, the job is paused or a limit stopped it; `cancelled` is set when the owner asked
 * to stop, which the caller acknowledges.
 */
export function holdLease({
  client,
  operationId,
  claimToken,
  leaseMs,
  intervalMs,
  outputBytes = () => 0,
  now = Date.now,
  signal,
}) {
  const controller = new AbortController();
  const state = { deadline: now() + leaseMs, cancelled: false, reason: null };
  const path = `/api/render-workers/operations/${operationId}/heartbeat`;
  let inFlight = null;
  const stop = (reason) => {
    if (controller.signal.aborted) return;
    state.reason = reason;
    controller.abort(new Error(reason));
  };
  const abort = () => stop('WORKER_STOPPED');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const beat = async () => {
    if (controller.signal.aborted) return;
    const started = now();
    try {
      const response = await client.post(
        path,
        { claimToken, outputBytes: String(outputBytes()) },
        {
          timeoutMs: Math.max(1000, Math.min(15_000, state.deadline - started)),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      if (response?.cancelRequested) {
        state.cancelled = true;
        stop('CANCELLED');
        return;
      }
      if (!response?.leaseExtended || response.pauseRequested || response.refusal) {
        stop(response?.refusal ? `LIMIT_${response.refusal}` : response?.pauseRequested ? 'PAUSED' : 'LEASE_LOST');
        return;
      }
      state.deadline = started + response.leaseMs;
    } catch {
      if (now() >= state.deadline) stop('LEASE_LOST');
    }
  };
  const timer = setInterval(
    () => {
      if (now() >= state.deadline) {
        stop('LEASE_LOST');
        return;
      }
      inFlight ??= beat().finally(() => {
        inFlight = null;
      });
    },
    Math.max(250, intervalMs),
  );
  timer.unref?.();
  return {
    signal: controller.signal,
    state,
    /** One heartbeat now; resolves once the lease is confirmed or lost. */
    async beat() {
      await (inFlight ??= beat().finally(() => {
        inFlight = null;
      }));
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    assertLive() {
      if (now() >= state.deadline) stop('LEASE_LOST');
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    async release() {
      clearInterval(timer);
      signal?.removeEventListener('abort', abort);
      stop('RELEASED');
      await inFlight;
    },
  };
}
