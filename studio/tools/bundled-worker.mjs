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
import { WorkerHttpError, createWorkerClient } from './bundled-worker-client.mjs';
import { executeBundledClaim } from './bundled-worker-executor.mjs';

const GIB = 1024 ** 3;
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
    if (trust?.version === 1 && typeof trust.workerId === 'string' && typeof trust.enrolmentSecret === 'string') return trust;
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

export async function admit({ client, trust, conformance, engineDigest, memoryBytes }) {
  return client.post('/api/render-workers/admission', {
    workerId: trust.workerId,
    enrolmentSecret: trust.enrolmentSecret,
    engineDigest,
    conformanceReportedAt: conformance.reportedAt.toISOString(),
    softwareRenderer: conformance.softwareRenderer,
    gpuMemoryBytes: String(memoryBytes),
    gpuWorkingBudgetEvidence: null,
    codecs: conformance.codecs,
    formats: conformance.formats,
  });
}

async function main() {
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
  const renderer = await createEngineRenderer({ log });
  const anonymous = createWorkerClient({ serverUrl: config.serverUrl });

  let waitingSince = null;
  let hinted = false;
  for (;;) {
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
      await sleep(config.pollMs);
      continue;
    }
    waitingSince = null;
    hinted = false;
    let session;
    try {
      const conformance = await renderer.conformance();
      if (conformance.formats.length === 0) {
        log('The conformance render produced no verified MP4; not offering exports. Retrying in 10 minutes.');
        await sleep(10 * 60_000);
        continue;
      }
      // The server rotates the enrolment at every start; read it again after the (slow) conformance render.
      const current = (await readTrust(config.trustFile)) ?? trust;
      session = await admit({ client: anonymous, trust: current, conformance, engineDigest: build.upstreamCommit, memoryBytes });
      log(`Admitted until ${session.expiresAt} (${conformance.softwareRenderer ? 'CPU' : 'GPU'}, ${memoryBytes / BigInt(GIB)} GiB)`);
    } catch (error) {
      log(`Admission failed (${error instanceof WorkerHttpError ? error.status : error.message}); retrying`);
      await sleep(Math.max(config.pollMs, 15_000));
      continue;
    }

    const client = anonymous.withSession(session.sessionToken);
    const renewAt = Date.parse(session.expiresAt) - 10 * 60_000;
    while (Date.now() < renewAt) {
      let claim;
      try {
        claim = await client.post('/api/render-workers/claims', { kinds: ['studio_export'] });
      } catch (error) {
        if (error instanceof WorkerHttpError && (error.status === 401 || error.status === 403)) break;
        log(`Claim request failed (${error.message})`);
        await sleep(config.pollMs);
        continue;
      }
      if (!claim) {
        await sleep(config.pollMs);
        continue;
      }
      log(`Claimed export ${claim.operationId} (attempt ${claim.attempt})`);
      const result = await executeBundledClaim(claim, {
        client,
        renderer,
        probe: renderer.probe,
        workRoot: config.workRoot,
        maxInputBytes: config.maxInputBytes,
        heartbeatIntervalMs: session.heartbeatIntervalMs,
        log,
      }).catch((error) => ({ status: 'failed', error }));
      if (result.error) log(`Export ${claim.operationId} ended unexpectedly: ${result.error.message}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.on('SIGTERM', () => process.exit(0));
  await main().catch((error) => {
    console.error('[studio-worker] stopped:', error?.message ?? error);
    process.exitCode = 1;
  });
}
