// FL-408: run one claimed Studio export on the bundled machine-learning worker.
//
// The protocol is the one every render worker uses: hold the lease, read only the claim's input
// grants, plan the whole-export checkpoint bound to the server's artifact input digest, upload the
// encoded bytes, ask the server to validate, then complete. A claim this worker cannot render is
// failed with a stable `bundled_*` code and a sentence the owner can act on. A completed checkpoint
// from an attempt that lost its lease (a restarted container) is reused, never re-rendered.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareClaimFonts } from './bundled-worker-fonts.mjs';
import { holdLease } from './bundled-worker-client.mjs';
import { audioPlan, encodeArgs, runFfmpeg } from './bundled-worker-formats.mjs';
import { writeHdrMaster } from './bundled-worker-hdr.mjs';
import { BundledRefusal, bundledRecipe, outputMismatch } from './bundled-worker-recipe.mjs';

const MEDIA_INPUT_KINDS = new Set(['library-asset', 'project-import']);
/** Font inputs are verified and registered separately from timeline media. */
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
 * @param context.probe `(file) => Promise<{ streams, format }>` (`probeMedia`)
 * @param context.ffmpeg the ffmpeg binary for second-pass formats (default `ffmpeg`)
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
    signal: context.signal,
    operationId: claim.operationId,
    claimToken: claim.claimToken,
    leaseMs: claim.leaseMs,
    intervalMs: Math.min(context.heartbeatIntervalMs ?? 30_000, Math.floor(claim.leaseMs / 3)),
    outputBytes: () => outputBytes,
  });
  const post = (pathname, body) => client.post(`${root}${pathname}`, { ...binding, ...body }, { signal: lease.signal });
  let folder;
  let outcome = 'failed';
  let failure;
  try {
    lease.assertLive();
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    folder = await mkdtemp(path.join(workRoot, 'claim-'));
    await lease.beat();
    const recipe = bundledRecipe(claim, {
      softwareRenderer: renderer.softwareRenderer,
      writers: renderer.writers,
    });
    const resumable = claim.checkpoints?.find(
      (checkpoint) =>
        checkpoint.sequence === 0 && checkpoint.chunkKey === recipe.chunkKey && checkpoint.state === 'complete',
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
      const outputPath = await renderClaim(claim, recipe, {
        ...context,
        folder,
        lease,
        post,
        onBytes: (bytes) => (outputBytes = bytes),
      });
      const size = (await stat(outputPath)).size;
      if (claim.limits?.maxOutputBytes && BigInt(size) > BigInt(claim.limits.maxOutputBytes)) {
        throw new BundledRefusal('output_too_large', 'The rendered export is larger than this server allows.');
      }
      // A sidecar export is a sealed pair: the media and the SRT the server sealed, uploaded as its sibling.
      const files = [{ file: outputPath, size, role: undefined }];
      if (recipe.captions.mode === 'sidecar') {
        const captions = path.join(folder, 'captions.srt');
        await writeFile(captions, recipe.captions.content, {
          flag: 'wx',
          mode: 0o600,
        });
        files.push({
          file: captions,
          size: Buffer.byteLength(recipe.captions.content),
          role: 'subtitle',
        });
      }
      for (const { file, size: bytes, role } of files) {
        lease.assertLive();
        const uploaded = await client.uploadArtifact(
          claim.operationId,
          claim.claimToken,
          file,
          {
            chunkKey: recipe.chunkKey,
            checksum: await sha256File(file),
            sizeInBytes: String(bytes),
            ...(role && { role }),
          },
          { signal: lease.signal },
        );
        if (!uploaded?.accepted) {
          throw new BundledRefusal(
            'artifact_refused',
            `The server refused the rendered ${role === 'subtitle' ? 'caption file' : 'file'}.`,
          );
        }
      }
    }

    await lease.beat();
    const complete = { artifactSequence: 0, resultAssetId: null };
    const validated = await post('/validate', complete);
    if (!validated?.accepted)
      throw new BundledRefusal('validation_refused', 'The server could not validate the rendered file.');
    await lease.beat();
    const completed = await post('/complete', complete);
    if (!completed?.accepted)
      throw new BundledRefusal('completion_refused', 'The server did not accept the finished export.');
    outcome = 'completed';
    log(`Export ${claim.operationId} completed`);
  } catch (error) {
    failure = error;
  } finally {
    const { cancelled, reason } = lease.state;
    await lease.release();
    if (folder) await rm(folder, { recursive: true, force: true });
    if (outcome !== 'completed') {
      outcome = await settleFailure(claim, client, {
        failure,
        cancelled,
        reason,
        log,
      });
    }
  }
  return {
    status: outcome,
    operationId: claim.operationId,
    ...(failure?.code && { code: failure.code }),
  };
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
      errorCode:
        reason === 'WORKER_STOPPED'
          ? 'bundled_worker_stopped'
          : refusal
            ? `bundled_${failure.code}`
            : 'bundled_render_failed',
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
  const { client, renderer, probe, folder, lease, post, maxInputBytes, onBytes, ffmpeg = 'ffmpeg' } = context;
  const inputs = path.join(folder, 'inputs');
  await mkdir(inputs, { mode: 0o700 });
  const files = new Map();
  const downloaded = new Map();
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
    const file = path.join(inputs, `${downloaded.size}-${MEDIA_INPUT_KINDS.has(input.kind) ? 'media' : 'verified'}`);
    let received;
    try {
      received = await client.download(claim.operationId, input, file, {
        maxBytes: budget,
        signal: lease.signal,
      });
    } catch (error) {
      if (error.message === 'INPUT_LIMIT_EXCEEDED') {
        throw new BundledRefusal(
          'inputs_too_large',
          'The project media is larger than the bundled Studio worker accepts.',
        );
      }
      if (error.message === 'INPUT_CHECKSUM_MISMATCH') {
        throw new BundledRefusal('input_changed', 'A source changed while it was being read; export again.');
      }
      throw error;
    }
    budget -= received.size;
    downloaded.set(input.inputId, file);
    if (MEDIA_INPUT_KINDS.has(input.kind)) files.set(input.resourceId, file);
  }
  for (const id of recipe.mediaIds) {
    if (!files.has(id)) {
      throw new BundledRefusal('missing_media', 'A clip reads media this export was not granted.');
    }
  }

  const fonts = await prepareClaimFonts(claim, downloaded, lease.signal);
  let frameTotal = recipe.frames * (recipe.pass === 'hdr' && recipe.hdr.transfer === 'pq' ? 2 : 1);
  await post('/progress', {
    status: 'preparing',
    stage: 'preparing',
    processedUnits: 0,
    totalUnits: frameTotal,
  });
  let reported = 0;
  let reportedStage = 'preparing';
  let progressWrites = Promise.resolve();
  const report = (fraction, evidence) => {
    const measured =
      evidence?.phase === 'rendering' &&
      Number.isSafeInteger(evidence.currentFrame) &&
      Number.isSafeInteger(evidence.totalFrames) &&
      evidence.currentFrame >= 0 &&
      evidence.totalFrames > 0 &&
      evidence.currentFrame <= evidence.totalFrames;
    const stage = ['encoding', 'finalizing'].includes(evidence?.phase)
      ? 'finalising'
      : evidence?.phase === 'preparing'
        ? 'preparing'
        : 'rendering';
    const processed =
      measured || (stage === 'finalising' && Number.isSafeInteger(evidence?.currentFrame))
        ? evidence.currentFrame
        : Math.min(frameTotal, Math.floor(fraction * frameTotal));
    if (measured) frameTotal = evidence.totalFrames;
    if (
      Number.isSafeInteger(processed) &&
      (stage !== reportedStage || processed - reported >= Math.max(1, Math.floor(frameTotal / 20)))
    ) {
      reported = processed;
      reportedStage = stage;
      progressWrites = progressWrites
        .then(() =>
          post('/progress', {
            status: stage === 'preparing' ? 'preparing' : 'rendering',
            stage,
            ...(measured && { unit: 'frames' }),
            processedUnits: processed,
            totalUnits: frameTotal,
          }),
        )
        .catch(() => {});
    }
  };
  const finalising = async () => {
    await progressWrites;
    await post('/progress', {
      status: 'rendering',
      stage: 'finalising',
      processedUnits: frameTotal,
      totalUnits: frameTotal,
    });
  };
  const engineOutput = path.join(folder, recipe.pass === 'engine' ? 'export.mp4' : 'master.mp4');
  if (recipe.pass === 'hdr') {
    const outputPath = await renderHdrMaster(recipe, {
      ...context,
      files,
      fonts,
      engineOutput,
      report,
    });
    await finalising();
    onBytes((await stat(outputPath)).size);
    const mismatch = outputMismatch(recipe, await probe(outputPath, { signal: lease.signal }));
    if (mismatch) throw new BundledRefusal('output_mismatch', `The export was not written as promised: ${mismatch}.`);
    return outputPath;
  }
  await renderer.render({
    fonts,
    project: recipe.graph,
    files,
    settings: recipe.settings,
    bounds: recipe.bounds,
    outputPath: engineOutput,
    signal: lease.signal,
    onProgress: report,
  });
  lease.assertLive();
  await finalising();
  let outputPath = engineOutput;
  if (recipe.pass !== 'engine') {
    outputPath = await secondPass(recipe, engineOutput, { ...context, ffmpeg });
    await rm(engineOutput, { force: true });
  }
  onBytes((await stat(outputPath)).size);
  const mismatch = outputMismatch(recipe, await probe(outputPath, { signal: lease.signal }));
  if (mismatch) throw new BundledRefusal('output_mismatch', `The export was not written as promised: ${mismatch}.`);
  return outputPath;
}

/**
 * FL-107: an HDR10 or HLG master. The engine's float route renders every frame as BT.2020 signal,
 * ffmpeg encodes HEVC Main10 with the BT.2100 rounding, and the file is decoded back and checked
 * before it can be uploaded (`writeHdrMaster`). The engine's ordinary render supplies only the sound.
 */
async function renderHdrMaster(recipe, context) {
  const {
    renderer,
    probe,
    folder,
    lease,
    files,
    fonts,
    engineOutput,
    report,
    ffmpeg = 'ffmpeg',
    ffprobe = 'ffprobe',
  } = context;
  let audio;
  if (recipe.contractAudio) {
    await renderer.render({
      fonts,
      project: recipe.graph,
      files,
      settings: recipe.settings,
      bounds: recipe.bounds,
      outputPath: engineOutput,
      signal: lease.signal,
      onProgress: () => {},
    });
    lease.assertLive();
    const sound = (await probe(engineOutput, { signal: lease.signal })).streams.find(
      (stream) => stream.codec_type === 'audio',
    );
    if (!sound)
      throw new BundledRefusal(
        'no_audio',
        'The engine wrote no sound for this project, so the HDR master would be silent.',
      );
    const plan = audioPlan(recipe.target, sound, new Set(renderer.encoders ?? ['aac']));
    audio = { path: engineOutput, stream: 0, codecArgs: plan.args };
  }
  const output = path.join(folder, `export${recipe.target.extension}`);
  try {
    await writeHdrMaster({
      ffmpeg,
      ffprobe,
      renderFrames: () =>
        renderer.renderSignalFrames({
          fonts,
          project: recipe.graph,
          files,
          bounds: recipe.bounds,
          target: recipe.hdr.transfer,
          signal: lease.signal,
        }),
      frameCount: recipe.frames,
      width: recipe.dimensions.width,
      height: recipe.dimensions.height,
      fps: recipe.hdr.cadence,
      transfer: recipe.hdr.transfer,
      mastering: recipe.hdr.mastering,
      audio,
      output,
      signal: lease.signal,
      onProgress: report,
    });
  } catch (error) {
    if (lease.signal.aborted) throw lease.signal.reason;
    if (error instanceof BundledRefusal) throw error;
    const reason = String(error?.message ?? error)
      .trim()
      .split('\n')[0];
    if (/mastering display/.test(reason)) throw new BundledRefusal('hdr_mastering_exceeded', reason);
    throw new BundledRefusal(
      'hdr_master_failed',
      `The HDR master failed its decode-back check (${reason}); nothing was exported.`,
    );
  } finally {
    await rm(engineOutput, { force: true });
  }
  return output;
}

/**
 * FL-105: write the requested format from the engine's master with this container's ffmpeg: a
 * stream copy for H.264 and AAC, an encode for every other codec, plus the sealed caption track.
 */
async function secondPass(recipe, master, { probe, folder, lease, ffmpeg, renderer }) {
  const masterAudio =
    (await probe(master, { signal: lease.signal })).streams.find((stream) => stream.codec_type === 'audio') ?? null;
  const audio = audioPlan(recipe.target, masterAudio, new Set(renderer.encoders ?? ['libopus']));
  if (audio.refusal) throw new BundledRefusal('unsupported_audio', audio.refusal);
  if (recipe.target.kind === 'audio' && !masterAudio) {
    throw new BundledRefusal('no_audio', 'The engine wrote no sound for this project, so there is nothing to export.');
  }
  let subtitles;
  if (recipe.captions.mode === 'embedded') {
    subtitles = path.join(folder, 'track.srt');
    await writeFile(subtitles, recipe.captions.content, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const output = path.join(folder, `export${recipe.target.extension}`);
  lease.assertLive();
  try {
    await runFfmpeg(
      encodeArgs({
        input: master,
        output,
        format: recipe.target,
        encoder: recipe.encoder,
        quality: recipe.quality,
        audio,
        subtitles,
      }),
      { ffmpeg, signal: lease.signal },
    );
  } catch (error) {
    if (lease.signal.aborted) throw lease.signal.reason;
    throw new BundledRefusal(
      'encode_failed',
      `This machine-learning container could not write ${recipe.target.id} (${
        String(error.stderr || error.message)
          .trim()
          .split('\n')[0]
      }).`,
    );
  }
  return output;
}
