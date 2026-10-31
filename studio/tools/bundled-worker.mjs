#!/usr/bin/env node
// FL-408: the Studio render worker bundled with the machine-learning container.
//
// It reads the enrolment the server wrote to the private trust volume, proves what it can encode
// with a real conformance render, is admitted as the server's bundled worker, and then claims and
// renders Studio exports one at a time. Nothing here is configured by hand on a default install.
//
//   FRAMELEAF_STUDIO_WORKER=false                 do not run
//   FRAMELEAF_STUDIO_WORKER_TRUST_DIR             the trust volume (default /run/frameleaf/studio-worker)
//   FRAMELEAF_STUDIO_WORKER_SERVER_URL            the server, as this container reaches it
//                                                 (default http://frameleaf-server:2283)
//   FRAMELEAF_STUDIO_WORKER_MEMORY_BYTES          working memory to declare (default: half of RAM, ≤ 8 GiB)
//   FRAMELEAF_STUDIO_WORKER_MAX_INPUT_BYTES       media one export may read (default 8 GiB)
//   FRAMELEAF_STUDIO_WORKER_WORK_DIR              private scratch space (default: the OS temp dir)
//   FRAMELEAF_STUDIO_CHROMIUM                     the browser binary (default /usr/bin/chromium)
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { WorkerHttpError, createWorkerClient } from './bundled-worker-client.mjs';
import { executeBundledClaim } from './bundled-worker-executor.mjs';

const GIB = 1024 ** 3;
const SESSION_RENEW_WINDOW_MS = 10 * 60_000;
const log = (message) => console.log(`[studio-worker] ${message}`);

export const workerConfig = (env = process.env) => ({
  enabled: !['false', '0', 'no', 'off'].includes(String(env.FRAMELEAF_STUDIO_WORKER ?? 'true').toLowerCase()),
  trustFile: path.join(env.FRAMELEAF_STUDIO_WORKER_TRUST_DIR || '/run/frameleaf/studio-worker', 'enrolment.json'),
  serverUrl: env.FRAMELEAF_STUDIO_WORKER_SERVER_URL || 'http://frameleaf-server:2283',
  memoryBytes: env.FRAMELEAF_STUDIO_WORKER_MEMORY_BYTES ? BigInt(env.FRAMELEAF_STUDIO_WORKER_MEMORY_BYTES) : null,
  maxInputBytes: Number(env.FRAMELEAF_STUDIO_WORKER_MAX_INPUT_BYTES || 8 * GIB),
  workRoot: path.join(env.FRAMELEAF_STUDIO_WORKER_WORK_DIR || os.tmpdir(), 'frameleaf-studio-worker'),
  pollMs: Number(env.FRAMELEAF_STUDIO_WORKER_POLL_MS || 5000),
});

/**
 * The working memory declared at admission. It gates resolution exactly as GPU memory does for a
 * GPU worker: half the container's RAM, at most 8 GiB, in whole GiB.
 */
export const workingMemoryBytes = (configured, totalMemory = os.totalmem()) => {
  if (configured !== null && configured !== undefined) return BigInt(configured);
  const half = BigInt(Math.floor(totalMemory / 2));
  const capped = half < 8n * BigInt(GIB) ? half : 8n * BigInt(GIB);
  return (capped / BigInt(GIB)) * BigInt(GIB);
};

/** The enrolment the server wrote, or null while it is not there yet. */
export async function readTrust(file) {
  try {
    const trust = JSON.parse(await readFile(file, 'utf8'));
    if (trust?.version === 1 && typeof trust.workerId === 'string' && typeof trust.enrolmentSecret === 'string')
      return trust;
  } catch {
    // not written yet, or mid-rotation; try again
  }
  return null;
}

/**
 * The enrolment only reaches this container through the studio-worker volume it shares with the
 * server on the same Docker host. Without that mount (an ML container on another host) it can never
 * enrol, so the worker says so once and stops instead of waiting forever.
 */
export async function trustVolumeMounted(file) {
  return stat(path.dirname(file)).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
}

export const NO_TRUST_VOLUME =
  'Cannot enrol: no studio-worker volume is mounted at %s. The server hands the bundled Studio worker ' +
  'its enrolment only through that volume, shared with a machine learning container on the same host. ' +
  'A machine learning container on another host cannot enrol, so Studio stays unavailable unless a ' +
  'machine learning container on the server host runs the worker. Set FRAMELEAF_STUDIO_WORKER=false ' +
  'to silence this message.';

/** How long to wait for an enrolment before explaining what can prevent it. */
export const ENROLMENT_HINT_MS = 5 * 60_000;

export async function admit({ client, trust, conformance, engineDigest, memoryBytes, signal }) {
  return client.post(
    '/api/render-workers/admission',
    {
      workerId: trust.workerId,
      enrolmentSecret: trust.enrolmentSecret,
      engineDigest,
      conformanceReportedAt: conformance.reportedAt.toISOString(),
      softwareRenderer: conformance.softwareRenderer,
      gpuMemoryBytes: String(memoryBytes),
      gpuWorkingBudgetEvidence: null,
      codecs: conformance.codecs,
      formats: conformance.formats,
      // FL-107: present only when this container wrote and decoded back a ten-bit HDR master.
      ...(conformance.colorPrecision && { colorPrecision: conformance.colorPrecision }),
    },
    { signal },
  );
}

/** Readiness is an admitted, usable session; credentials never cross the owner channel. */
export function sessionReady(session, workerId, engineDigest, now = Date.now()) {
  const expiry = typeof session?.expiresAt === 'string' ? Date.parse(session.expiresAt) : NaN;
  if (
    session?.workerId !== workerId ||
    typeof workerId !== 'string' ||
    !workerId ||
    typeof session?.sessionToken !== 'string' ||
    session.sessionToken.length > 1024 ||
    !/^[\x21-\x7e]+$/.test(session.sessionToken) ||
    !Number.isFinite(expiry) ||
    expiry <= now + SESSION_RENEW_WINDOW_MS ||
    !Array.isArray(session.scopes) ||
    !session.scopes.includes('studio_export') ||
    !Number.isSafeInteger(session.leaseMs) ||
    session.leaseMs <= 0 ||
    session.leaseMs > 2_147_483_647 ||
    !Number.isSafeInteger(session.heartbeatIntervalMs) ||
    session.heartbeatIntervalMs <= 0 ||
    session.heartbeatIntervalMs >= session.leaseMs ||
    typeof engineDigest !== 'string' ||
    !/^[a-f0-9]{40}$/.test(engineDigest)
  ) {
    throw new Error('WORKER_ADMISSION_INVALID');
  }
  return {
    protocolVersion: 1,
    state: 'ready',
    engineDigest,
    expiresAt: new Date(expiry).toISOString(),
  };
}

/** Native ownership is a one-command private pipe; containers do not opt in. */
export function bindOwnerPipe(input, shutdown) {
  let pending = '';
  const abort = (reason) => {
    input.pause();
    shutdown.abort(new Error(reason));
  };
  const stop = () => abort('WORKER_STOPPED');
  const read = (chunk) => {
    if (shutdown.signal.aborted) return;
    if (chunk.length > 5 - pending.length) {
      abort('WORKER_OWNER_COMMAND_INVALID');
      return;
    }
    pending += chunk.toString();
    if (!'stop\n'.startsWith(pending)) abort('WORKER_OWNER_COMMAND_INVALID');
    else if (pending === 'stop\n') stop();
  };
  input.on('data', read);
  input.on('end', stop);
  input.on('error', stop);
  return () => {
    input.removeListener('data', read);
    input.removeListener('end', stop);
    input.removeListener('error', stop);
    input.destroy();
  };
}

export async function main(signal, report = () => {}) {
  signal.throwIfAborted();
  const pause = (milliseconds) => sleep(milliseconds, undefined, { signal });
  const config = workerConfig();
  if (!config.enabled) {
    log('Disabled (FRAMELEAF_STUDIO_WORKER=false); Studio exports need another render worker.');
    return;
  }
  if (!(await trustVolumeMounted(config.trustFile))) {
    log(NO_TRUST_VOLUME.replace('%s', path.dirname(config.trustFile)));
    return;
  }
  const build = JSON.parse(await readFile(new URL('../engine-build.json', import.meta.url), 'utf8'));
  const memoryBytes = workingMemoryBytes(config.memoryBytes);
  if (memoryBytes < 2n * BigInt(GIB)) {
    log('Less than 4 GiB of memory is available to this container; Studio exports need at least 2 GiB to render.');
    return;
  }
  const { createEngineRenderer } = await import('./bundled-worker-renderer.mjs');
  const renderer = await createEngineRenderer({ log, signal });
  const anonymous = createWorkerClient({ serverUrl: config.serverUrl });
  const qualifying = { protocolVersion: 1, state: 'qualifying' };
  await report(qualifying);

  let waitingSince = null;
  let hinted = false;
  while (!signal.aborted) {
    const trust = await readTrust(config.trustFile);
    if (!trust) {
      if (waitingSince === null) {
        waitingSince = Date.now();
        log(`Waiting for the server's enrolment in ${path.dirname(config.trustFile)}`);
      } else if (!hinted && Date.now() - waitingSince >= ENROLMENT_HINT_MS) {
        hinted = true;
        log(
          `Still no enrolment after ${ENROLMENT_HINT_MS / 60_000} minutes. The server writes it to the studio-worker ` +
            'volume when it starts; the volume must be the same one the server mounts, which is only possible on ' +
            'the same host. Until then Studio stays unavailable.',
        );
      }
      await pause(config.pollMs);
      continue;
    }
    waitingSince = null;
    hinted = false;
    let session, readiness;
    try {
      const conformance = await renderer.conformance({ signal });
      if (conformance.formats.length === 0) {
        log('The conformance render produced no verified MP4; not offering exports. Retrying in 10 minutes.');
        await pause(10 * 60_000);
        continue;
      }
      // The server rotates the enrolment at every start; read it again after the (slow) conformance render.
      const current = (await readTrust(config.trustFile)) ?? trust;
      session = await admit({
        client: anonymous,
        trust: current,
        conformance,
        engineDigest: build.upstreamCommit,
        memoryBytes,
        signal,
      });
      readiness = sessionReady(session, current.workerId, build.upstreamCommit);
      log(
        `Admitted until ${session.expiresAt} (${conformance.softwareRenderer ? 'CPU' : 'GPU'}, ${memoryBytes / BigInt(GIB)} GiB)`,
      );
    } catch (error) {
      signal.throwIfAborted();
      log(`Admission failed (${error instanceof WorkerHttpError ? error.status : error.message}); retrying`);
      await pause(Math.max(config.pollMs, 15_000));
      continue;
    }

    signal.throwIfAborted();
    await report(readiness);
    signal.throwIfAborted();
    const client = anonymous.withSession(session.sessionToken);
    const renewAt = Date.parse(session.expiresAt) - SESSION_RENEW_WINDOW_MS;
    while (!signal.aborted && Date.now() < renewAt) {
      let claim;
      try {
        claim = await client.post('/api/render-workers/claims', { kinds: ['studio_export'] }, { signal });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof WorkerHttpError && (error.status === 401 || error.status === 403)) break;
        log(`Claim request failed (${error.message})`);
        await pause(config.pollMs);
        continue;
      }
      if (!claim) {
        await pause(config.pollMs);
        continue;
      }
      log(`Claimed export ${claim.operationId} (attempt ${claim.attempt})`);
      const result = await executeBundledClaim(claim, {
        client,
        signal,
        renderer,
        probe: renderer.probe,
        workRoot: config.workRoot,
        maxInputBytes: config.maxInputBytes,
        heartbeatIntervalMs: session.heartbeatIntervalMs,
        log,
      }).catch((error) => ({ status: 'failed', error }));
      if (result.error) log(`Export ${claim.operationId} ended unexpectedly: ${result.error.message}`);
    }
    if (!signal.aborted) await report(qualifying);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--owner-pipe')) {
    throw new Error('Usage: bundled-worker.mjs [--owner-pipe]');
  }
  const shutdown = new AbortController();
  const stop = () => shutdown.abort(new Error('WORKER_STOPPED'));
  const ownerMode = args.length === 1;
  if (ownerMode && (!process.connected || typeof process.send !== 'function')) {
    throw new Error('Native Studio ownership requires an IPC channel');
  }
  const releaseOwner = ownerMode ? bindOwnerPipe(process.stdin, shutdown) : null;
  const report = ownerMode
    ? async (message) => {
        try {
          await promisify(process.send.bind(process))(message);
        } catch {
          stop();
          throw shutdown.signal.reason;
        }
      }
    : undefined;
  if (ownerMode) process.on('disconnect', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    await main(shutdown.signal, report);
  } catch (error) {
    if (!shutdown.signal.aborted) {
      console.error('[studio-worker] stopped:', error?.message ?? error);
      process.exitCode = 1;
    }
  } finally {
    releaseOwner?.();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (ownerMode) {
      process.removeListener('disconnect', stop);
      if (process.connected) process.disconnect();
    }
    if (shutdown.signal.reason?.message === 'WORKER_OWNER_COMMAND_INVALID') {
      console.error('[studio-worker] invalid owner command');
      process.exitCode = 1;
    }
  }
}
