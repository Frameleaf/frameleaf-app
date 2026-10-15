// FL-408: run one claimed Studio export on the bundled machine-learning worker.
//
// The protocol is the one every render worker uses: hold the lease, read only the claim's input
// grants, plan the whole-export checkpoint bound to the server's artifact input digest, upload the
// encoded bytes, ask the server to validate, then complete. A claim this worker cannot render is
// failed with a stable `bundled_*` code and a sentence the owner can act on. A completed checkpoint
// from an attempt that lost its lease (a restarted container) is reused, never re-rendered.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { holdLease } from './bundled-worker-client.mjs';
import { BundledRefusal, bundledRecipe, outputMismatch } from './bundled-worker-recipe.mjs';

const MEDIA_INPUT_KINDS = new Set(['library-asset', 'project-import']);
/** Inputs a bundled render verifies but does not need as media: title fonts are installed with it. */
const VERIFIED_ONLY_INPUT_KINDS = new Set(['font']);

const sha256File = async (file) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

/**
 * @param claim the server's claim
 * @param context.client a worker client with the session (`createWorkerClient`)
 * @param context.renderer `{ softwareRenderer, render({ project, media, settings, bounds, outputPath, signal, onProgress }) }`
 * @param context.probe `(file) => Promise<ffprobe streams>`
 * @param context.workRoot where private per-claim directories are made
 * @param context.maxInputBytes the byte budget for all of a claim's inputs together
 */
export async function executeBundledClaim(claim, context) {
  const { client, renderer, probe, workRoot, maxInputBytes, log = () => {} } = context;
  const root = `/api/render-workers/operations/${claim.operationId}`;
  const binding = { claimToken: claim.claimToken };
  let outputBytes = 0;
  const lease = holdLease({
    client,
    operationId: claim.operationId,
    claimToken: claim.claimToken,
    leaseMs: claim.leaseMs,
    intervalMs: Math.min(context.heartbeatIntervalMs ?? 30_000, Math.floor(claim.leaseMs / 3)),
    outputBytes: () => outputBytes,
  });
  const post = (pathname, body) => client.post(`${root}${pathname}`, { ...binding, ...body }, { signal: lease.signal });
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(path.join(workRoot, 'claim-'));
  let outcome = 'failed';
  let failure;
  try {
    await lease.beat();
    const recipe = bundledRecipe(claim, { softwareRenderer: renderer.softwareRenderer });
    const resumable = claim.checkpoints?.find(
      (checkpoint) => checkpoint.sequence === 0 && checkpoint.chunkKey === recipe.chunkKey && checkpoint.state === 'complete',
    );

    const planned = await post('/checkpoints', {
      sequence: 0,
      chunkKey: recipe.chunkKey,
      inputDigest: claim.artifactInputDigest,
      historyDigest: recipe.historyDigest,
      configDigest: recipe.configDigest,
      seed: null,
      timebase: recipe.timebase,
      startTicks: '0',
      endTicks: recipe.endTicks,
      requiresSequentialContext: false,
    });
    if (!planned?.accepted) throw new BundledRefusal('plan_refused', 'The server refused the export plan.');

    if (resumable) {
      log(`Export ${claim.operationId}: reusing the artifact a previous attempt finished`);
    } else {
      const outputPath = await renderClaim(claim, recipe, { ...context, folder, lease, post, onBytes: (bytes) => (outputBytes = bytes) });
      const size = (await stat(outputPath)).size;
      if (claim.limits?.maxOutputBytes && BigInt(size) > BigInt(claim.limits.maxOutputBytes)) {
        throw new BundledRefusal('output_too_large', 'The rendered export is larger than this server allows.');
      }
      lease.assertLive();
      const uploaded = await client.uploadArtifact(
        claim.operationId,
        claim.claimToken,
        outputPath,
        { chunkKey: recipe.chunkKey, checksum: await sha256File(outputPath), sizeInBytes: String(size) },
        { signal: lease.signal },
      );
      if (!uploaded?.accepted) throw new BundledRefusal('artifact_refused', 'The server refused the rendered file.');
    }

    await lease.beat();
    const complete = { artifactSequence: 0, resultAssetId: null };
    const validated = await post('/validate', complete);
    if (!validated?.accepted) throw new BundledRefusal('validation_refused', 'The server could not validate the rendered file.');
    await lease.beat();
    const completed = await post('/complete', complete);
    if (!completed?.accepted) throw new BundledRefusal('completion_refused', 'The server did not accept the finished export.');
    outcome = 'completed';
    log(`Export ${claim.operationId} completed`);
  } catch (error) {
    failure = error;
  } finally {
    const { cancelled, reason } = lease.state;
    lease.release();
    await rm(folder, { recursive: true, force: true });
    if (outcome !== 'completed') {
      outcome = await settleFailure(claim, client, { failure, cancelled, reason, log });
    }
  }
  return { status: outcome, operationId: claim.operationId, ...(failure?.code && { code: failure.code }) };
}

/** Tell the server how the attempt ended: a cancel is acknowledged, a refusal or failure reported. */
async function settleFailure(claim, client, { failure, cancelled, reason, log }) {
  const root = `/api/render-workers/operations/${claim.operationId}`;
  const binding = { claimToken: claim.claimToken };
  try {
    if (cancelled) {
      await client.post(`${root}/cancel-ack`, { ...binding, released: true });
      log(`Export ${claim.operationId} cancelled by its owner`);
      return 'cancelled';
    }
    if (reason === 'PAUSED' || reason === 'LEASE_LOST' || reason?.startsWith('LIMIT_')) {
      // The server already took the claim back (pause, expiry or a limit); it records why.
      log(`Export ${claim.operationId} stopped: ${reason}`);
      return reason === 'PAUSED' ? 'paused' : 'lease_lost';
    }
    const refusal = failure instanceof BundledRefusal;
    await client.post(`${root}/fail`, {
      ...binding,
      errorCode: refusal ? `bundled_${failure.code}` : 'bundled_render_failed',
      error: refusal
        ? failure.message
        : 'The bundled Studio worker could not finish this export. Check the machine-learning container log.',
    });
    log(`Export ${claim.operationId} failed: ${refusal ? failure.code : failure?.message}`);
    return refusal ? 'refused' : 'failed';
  } catch {
    return 'lease_lost';
  }
}

/** Read the claim's inputs, render with the engine and check the encoded file. Returns its path. */
async function renderClaim(claim, recipe, context) {
  const { client, renderer, probe, folder, lease, post, maxInputBytes, onBytes } = context;
  const inputs = path.join(folder, 'inputs');
  await mkdir(inputs, { mode: 0o700 });
  const files = new Map();
  let budget = maxInputBytes;
  for (const input of claim.inputs ?? []) {
    lease.assertLive();
    const known = MEDIA_INPUT_KINDS.has(input.kind) || VERIFIED_ONLY_INPUT_KINDS.has(input.kind);
    if (!known) {
      throw new BundledRefusal(
        'unsupported_resource',
        `This project uses a ${input.kind} resource, which the bundled Studio worker cannot render yet.`,
      );
    }
    const file = path.join(inputs, `${files.size}-${MEDIA_INPUT_KINDS.has(input.kind) ? 'media' : 'verified'}`);
    let received;
    try {
      received = await client.download(claim.operationId, input, file, { maxBytes: budget, signal: lease.signal });
    } catch (error) {
      if (error.message === 'INPUT_LIMIT_EXCEEDED') {
        throw new BundledRefusal('inputs_too_large', 'The project media is larger than the bundled Studio worker accepts.');
      }
      if (error.message === 'INPUT_CHECKSUM_MISMATCH') {
        throw new BundledRefusal('input_changed', 'A source changed while it was being read; export again.');
      }
      throw error;
    }
    budget -= received.size;
    if (MEDIA_INPUT_KINDS.has(input.kind)) files.set(input.resourceId, file);
  }
  for (const id of recipe.mediaIds) {
    if (!files.has(id)) {
      throw new BundledRefusal('missing_media', 'A clip reads media this export was not granted.');
    }
  }

  await post('/progress', { status: 'rendering', processedUnits: 0, totalUnits: recipe.frames });
  let reported = 0;
  const outputPath = path.join(folder, 'export.mp4');
  await renderer.render({
    project: recipe.graph,
    files,
    settings: recipe.settings,
    bounds: recipe.bounds,
    outputPath,
    signal: lease.signal,
    onProgress: (fraction) => {
      const processed = Math.min(recipe.frames, Math.floor(fraction * recipe.frames));
      if (processed - reported >= Math.max(1, Math.floor(recipe.frames / 20))) {
        reported = processed;
        void post('/progress', { status: 'rendering', processedUnits: processed, totalUnits: recipe.frames }).catch(() => {});
      }
    },
  });
  lease.assertLive();
  onBytes((await stat(outputPath)).size);
  const mismatch = outputMismatch(recipe, await probe(outputPath));
  if (mismatch) throw new BundledRefusal('output_mismatch', `The export was not written as promised: ${mismatch}.`);
  return outputPath;
}
