#!/usr/bin/env node
// One real claim/input preparation attempt, with an optional explicit qualified executor.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClaimImageInputs } from './render-worker-image-inputs.mjs';

const byteLimit = 32 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function boundedBytes(response, maximum) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('INPUT_UNAVAILABLE');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= maximum, 'INPUT_LIMIT_EXCEEDED');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Requires a session obtained by a separately qualified worker; never manufactures admission. */
export async function prepareOneClaim({ serverUrl, sessionToken, execute }) {
  const server = new URL(serverUrl);
  assert.ok(['https:', 'http:'].includes(server.protocol) && !server.username && !server.password &&
    server.pathname === '/' && !server.search && !server.hash, 'Use the server origin without a path or credentials');
  assert.ok(typeof sessionToken === 'string' && sessionToken.length > 0, 'An admitted worker session is required');
  const headers = { 'x-frameleaf-worker-session': sessionToken, 'Content-Type': 'application/json' };
  const request = async (pathname, body, timeout = 10_000, signal) => {
    const response = await fetch(new URL(pathname, server), {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
    if (response.status === 204) return null;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('WORKER_REQUEST_REFUSED');
    }
    return JSON.parse((await boundedBytes(response, byteLimit)).toString('utf8'));
  };
  const claim = await request('/api/render-workers/claims', { kinds: ['studio_export'] });
  if (!claim) return { status: 'idle' };
  assert.ok(uuid.test(claim.operationId) && uuid.test(claim.claimToken), 'INVALID_CLAIM_BINDING');
  const operationPath = `/api/render-workers/operations/${claim.operationId}`;
  const binding = { claimToken: claim.claimToken };
  let ownsLease = false;
  let deadline = 0;
  let status = 'failed';
  let errorCode = 'worker_input_preparation_failed';
  const inputs = new Map();
  const clearInputs = () => { for (const input of inputs.values()) input.bytes.fill(0); inputs.clear(); };
  const sendHeartbeat = async () => {
    ownsLease = false; // A lost acknowledgement is not permission to keep reading or writing.
    const started = performance.now();
    const beat = await request(`${operationPath}/heartbeat`, { ...binding, outputBytes: '0' });
    assert.ok(beat && Number.isFinite(beat.leaseMs) && beat.leaseMs > 1000, 'INVALID_LEASE');
    deadline = started + beat.leaseMs;
    if (beat.pauseRequested || beat.refusal || !beat.leaseExtended || performance.now() >= deadline) {
      status = 'lease_lost';
      throw new Error('LEASE_LOST');
    }
    ownsLease = true;
    if (beat.cancelRequested) {
      await releaseExecutor();
      clearInputs();
      const ack = await request(`${operationPath}/cancel-ack`, { ...binding, released: true });
      assert.equal(ack?.accepted, true, 'CANCEL_ACK_REFUSED');
      ownsLease = false;
      status = 'cancelled';
      throw new Error('CANCELLED');
    }
  };
  let heartbeatPending;
  const heartbeat = () => heartbeatPending ??= sendHeartbeat().finally(() => { heartbeatPending = undefined; });
  let prepared;
  let engineInputs;
  let releaseExecutor = async () => {};
  const startedAt = performance.now();
  try {
    await heartbeat();
    assert.equal(claim.kind, 'studio_export');
    assert.ok(typeof claim.artifactInputDigest === 'string' && /^[a-f0-9]{64}$/.test(claim.artifactInputDigest), 'INPUT_DIGEST_REQUIRED');
    assert.ok(claim.projectId && claim.revisionId && claim.snapshot?.studio?.graph &&
      Number.isSafeInteger(claim.snapshot.studio.revision) && Array.isArray(claim.inputs), 'IMMUTABLE_GRAPH_UNAVAILABLE');
    // Snapshot/settings are never fetched from a mutable project head or interpreted as local paths.
    prepared = { operationId: claim.operationId, claimToken: claim.claimToken,
      projectId: claim.projectId, revisionId: claim.revisionId, artifactInputDigest: claim.artifactInputDigest,
      snapshot: structuredClone(claim.snapshot), settings: structuredClone(claim.settings), inputs };
    let total = 0;
    for (const input of claim.inputs) {
      await heartbeat();
      const prefix = `${operationPath}/inputs/`;
      assert.ok(typeof input.url === 'string' && input.url.startsWith(prefix) &&
        /^[A-Za-z0-9_.-]+$/.test(input.url.slice(prefix.length)), 'INVALID_INPUT_GRANT_URL');
      assert.ok(typeof input.inputId === 'string' && !inputs.has(input.inputId), 'DUPLICATE_INPUT_BINDING');
      assert.ok(Date.parse(input.expiresAt) > Date.now(), 'INPUT_GRANT_EXPIRED');
      const remaining = Math.floor(deadline - performance.now());
      assert.ok(remaining > 1000, 'LEASE_LOST');
      const response = await fetch(new URL(input.url, server), {
        headers: { 'x-frameleaf-worker-session': sessionToken }, redirect: 'error',
        signal: AbortSignal.timeout(Math.min(10_000, remaining - 500)),
      });
      const bytes = await boundedBytes(response, byteLimit - total);
      // The server revalidates the signed resource checksum on every grant read. Record a local
      // SHA-256 as well so a later executor can bind exactly these bytes to this input ID.
      inputs.set(input.inputId, { bytes, resourceId: input.resourceId, kind: input.kind,
        declaredChecksum: input.checksum, sha256: createHash('sha256').update(bytes).digest('hex') });
      if (input.checksum !== null) {
        assert.equal(typeof input.checksum, 'string', 'INVALID_INPUT_CHECKSUM');
        const hex = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.checksum);
        const digest = Buffer.from(input.checksum, hex ? 'hex' : 'base64');
        assert.ok([20, 32].includes(digest.length) && (hex || digest.toString('base64') === input.checksum),
          'INVALID_INPUT_CHECKSUM');
        assert.ok(createHash(digest.length === 20 ? 'sha1' : 'sha256').update(bytes).digest().equals(digest),
          'INPUT_CHECKSUM_MISMATCH');
      }
      total += bytes.length;
    }
    await heartbeat();
    engineInputs = await createClaimImageInputs(prepared, () => ownsLease && performance.now() < deadline);
    // Preparation-only callers keep the old fail-closed behavior. An explicit executor must
    // consume the immutable adapter under this lease and return server-accepted completion.
    if (execute) {
      errorCode = 'worker_executor_failed';
      const result = await execute({ claim, prepared, engineInputs, heartbeat, request,
        isLeaseActive: () => ownsLease && performance.now() < deadline,
        elapsedMs: () => performance.now() - startedAt,
        registerRelease: (release) => { releaseExecutor = async () => { await release(); await engineInputs?.dispose(); }; },
        upload: async (file, metadata, signal) => {
          await heartbeat();
          assert.ok(ownsLease && performance.now() < deadline, 'LEASE_LOST');
          const { createReadStream } = await import('node:fs');
          const query = new URLSearchParams(metadata);
          const stream = createReadStream(file);
          try {
            const response = await fetch(new URL(`${operationPath}/artifacts/0?${query}`, server), {
            method: 'PUT', headers: { 'x-frameleaf-worker-session': sessionToken,
              'x-render-claim-token': claim.claimToken, 'Content-Type': 'application/octet-stream' },
            body: stream, duplex: 'half', redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(deadline - performance.now())))]),
          });
            if (!response.ok) { await response.body?.cancel(); throw new Error('ARTIFACT_REFUSED'); }
            return JSON.parse((await boundedBytes(response, byteLimit)).toString());
          } finally { stream.destroy(); }
        },
      });
      assert.equal(result?.accepted, true, 'COMPLETION_REFUSED');
      status = 'completed';
    } else errorCode = 'worker_executor_unavailable';
  } catch {
    // URLs contain signed grants. Never echo an HTTP error, graph or credential into logs.
    if (!ownsLease && status === 'failed') status = 'lease_lost';
  } finally {
    await releaseExecutor();
    await engineInputs?.dispose();
    clearInputs();
    prepared = undefined;
    if (ownsLease && status !== 'completed') {
      // Recheck cancellation/lease loss before consuming the claim with a failure report.
      try { await heartbeat(); } catch { ownsLease = false; if (status !== 'cancelled') status = 'lease_lost'; }
      if (ownsLease) {
        const result = await request(`${operationPath}/fail`, { ...binding,
          errorCode, error: errorCode === 'worker_executor_unavailable'
            ? 'Authorized inputs prepared; render execution is not implemented.'
            : 'Worker attempt refused; no completion accepted.',
        }, Math.max(1, Math.min(10_000, Math.floor(deadline - performance.now()))));
        assert.equal(result?.accepted, true, 'FAILURE_REPORT_REFUSED');
      }
    }
  }
  return { status, operationId: claim.operationId, errorCode: status === 'failed' ? errorCode : null,
    published: status === 'completed' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await prepareOneClaim({ serverUrl: process.env.FRAMELEAF_URL,
      sessionToken: process.env.FRAMELEAF_WORKER_SESSION });
    console.log(JSON.stringify(result));
    if (result.status !== 'idle') process.exitCode = 1;
  } catch { console.error('Worker claim attempt failed; no output published.'); process.exitCode = 1; }
}
