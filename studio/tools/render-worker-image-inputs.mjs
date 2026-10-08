// FL-145: the still-image subset of Freecut's HeadlessProjectInput/HeadlessFrameInput.
import assert from 'node:assert/strict';
import { deriveClaimVectors } from './render-worker-vector-inputs.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventory } from './engine.mjs';
import { inspectVerifiedVideo, reconcileVideoTiming, timelineViews } from './render-worker-video-inputs.mjs';
import { deriveClaimFileLuts } from './render-worker-lut-inputs.mjs';
import { decodeHdrRaster } from './hdr-raster-input.mjs';

const studio = fileURLToPath(new URL('../', import.meta.url));
const engine = path.join(studio, 'engine');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function validateStillImage(bytes, sharp) {
  assert.ok(bytes.length <= 32 * 1024 * 1024, 'IMAGE_BYTE_LIMIT');
  // Reject non-raster formats before invoking a decoder (SVG may contain external resources).
  const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? 'jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        ? 'webp'
        : bytes.length >= 16 &&
            bytes.toString('ascii', 4, 8) === 'ftyp' &&
            ['heic', 'heix', 'mif1', 'avif'].includes(bytes.toString('ascii', 8, 12))
          ? 'heif'
          : null;
  assert.ok(format, 'UNSUPPORTED_IMAGE_CONTENT');
  // The isolated pinned libheif decoder validates the primary image. Studio's Sharp may
  // lack HEVC; it must not select an auxiliary image or flatten HDR before that validation.
  if (format === 'heif') return { format };
  // libvips can expose only the first APNG frame. Refuse animation instead of silently flattening it.
  let hdrPng = false;
  if (format === 'png') {
    for (let offset = 8; offset < bytes.length;) {
      assert.ok(offset + 12 <= bytes.length, 'INVALID_IMAGE_CONTENT');
      const length = bytes.readUInt32BE(offset);
      assert.ok(offset + length + 12 <= bytes.length, 'INVALID_IMAGE_CONTENT');
      const chunk = bytes.toString('ascii', offset + 4, offset + 8);
      assert.notEqual(chunk, 'acTL', 'ANIMATED_IMAGE_UNSUPPORTED');
      if (chunk === 'cICP' && length >= 4 && [16, 18].includes(bytes[offset + 9])) hdrPng = true;
      offset += length + 12;
    }
  }
  const decoder = sharp(bytes, { limitInputPixels: 48_000_000, failOn: 'warning', animated: true }).timeout({
    seconds: 5,
  });
  try {
    const metadata = await decoder.metadata();
    assert.equal(metadata.format, format, 'IMAGE_FORMAT_MISMATCH');
    assert.equal(metadata.pages ?? 1, 1, 'ANIMATED_IMAGE_UNSUPPORTED');
    assert.ok(
      metadata.width > 0 && metadata.height > 0 && metadata.width * metadata.height <= 48_000_000,
      'IMAGE_PIXEL_LIMIT',
    );
    // Metadata/signatures alone do not prove a complete image. Decode all pixels, then discard
    // the validation buffer; the original verified source bytes are what the renderer receives.
    const decoded = await decoder.raw().toBuffer();
    decoded.fill(0);
    return { format: hdrPng ? 'hdr-png' : format, width: metadata.width, height: metadata.height };
  } finally {
    decoder.destroy();
  }
}

/** Check the complete server-resolved closure before creating any engine-visible resource. */
export function validateClaimResourceClosure(prepared, extraction) {
  assert.equal(extraction.violations.length, 0, 'INVALID_GRAPH_RESOURCE');
  const entries = prepared.snapshot?.studio?.resources;
  assert.ok(Array.isArray(entries), 'RESOLVED_RESOURCE_CLOSURE_REQUIRED');
  const keyOf = ({ kind, id, family }) => family ? `${kind}:${family}:${id}` : `${kind}:${id}`;
  const references = new Map();
  for (const reference of extraction.references) {
    const key = keyOf(reference);
    assert.ok(!references.has(key), 'DUPLICATE_GRAPH_RESOURCE');
    references.set(key, reference);
  }
  assert.equal(entries.length, references.size, 'RESOURCE_CLOSURE_CHANGED');
  const seen = new Set();
  let readable = 0;
  for (const entry of entries) {
    const reference = references.get(entry.key);
    assert.ok(reference && !seen.has(entry.key), 'RESOURCE_CLOSURE_CHANGED');
    seen.add(entry.key);
    assert.equal(entry.key, keyOf(entry), 'RESOURCE_IDENTITY_CHANGED');
    for (const field of ['kind', 'id', 'family', 'source', 'graphPath'])
      assert.equal(entry[field], reference[field], 'RESOURCE_IDENTITY_CHANGED');
    assert.ok(entry.grant === 'render' || entry.grant === 'none', 'INVALID_RESOURCE_GRANT');
    const input = prepared.inputs.get(entry.key);
    if (entry.grant === 'none') {
      assert.ok(!input && (entry.checksum === null || typeof entry.checksum === 'string'), 'UNEXPECTED_RESOURCE_BYTES');
      continue;
    }
    readable++;
    assert.ok(input && Buffer.isBuffer(input.bytes), 'AUTHORIZED_RESOURCE_INPUT_REQUIRED');
    assert.equal(input.resourceId, entry.id, 'RESOURCE_IDENTITY_CHANGED');
    assert.equal(input.kind, entry.kind, 'RESOURCE_IDENTITY_CHANGED');
    assert.ok(typeof entry.checksum === 'string' && entry.checksum.length > 0, 'RESOURCE_CHECKSUM_REQUIRED');
    assert.equal(input.declaredChecksum, entry.checksum, 'RESOURCE_CHECKSUM_CHANGED');
    assert.equal(sha256(input.bytes), input.sha256, 'VERIFIED_INPUT_CHANGED');
  }
  assert.equal(prepared.inputs.size, readable, 'UNSUPPORTED_OR_UNUSED_RESOURCE');
}

/** Admit immutable inline RGBA8 LUT bytes before the renderer can fall back to identity. */
export function validateInlineLuts(project) {
  let allocated = 0;
  const pending = [project];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'gpu-effect' && node.gpuEffectType === 'gpu-lut') {
      const params = node.params;
      assert.ok(params && typeof params === 'object', 'INVALID_INLINE_LUT');
      if (params.lutSize === '0' && params.lutData === '' && params.lutName === '') continue;
      const size =
        typeof params.lutSize === 'string' || typeof params.lutSize === 'number' ? Number(params.lutSize) : NaN;
      assert.ok(
        Number.isInteger(size) &&
          size >= 2 &&
          size <= 129 &&
          typeof params.lutName === 'string' &&
          typeof params.lutData === 'string',
        'INVALID_INLINE_LUT',
      );
      const length = size ** 3 * 4;
      assert.equal(params.lutData.length, 4 * Math.ceil(length / 3), 'INVALID_INLINE_LUT');
      allocated += length;
      assert.ok(allocated <= 8 * 1024 * 1024, 'INLINE_LUT_ALLOCATION_LIMIT');
      const bytes = Buffer.from(params.lutData, 'base64');
      try {
        assert.equal(bytes.length, length, 'INVALID_INLINE_LUT');
        assert.equal(bytes.toString('base64'), params.lutData, 'INVALID_INLINE_LUT');
      } finally {
        bytes.fill(0);
      }
    }
    pending.push(...Object.values(node));
  }
}

/** Existing adapter-owned cleanup, kept independent of source/build admission for failure tests. */
export async function disposeClaimImageResources({ pool, sources, vectors, hdrRasters, harness, server, folder }, failure) {
  let cleanupError;
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      cleanupError ??= error;
    }
  };
  for (const source of sources) await attempt(() => source.bytes.fill(0));
  for (const source of vectors.sources) await attempt(() => source.bytes.fill(0));
  for (const raster of Object.values(hdrRasters)) {
    await attempt(() => raster.rgba?.fill(0));
    await attempt(() => raster.rgb?.fill(0));
  }
  await attempt(() => pool?.close());
  await attempt(() => harness?.close());
  await attempt(() => server?.close());
  if (folder) await attempt(() => rm(folder, { recursive: true, force: true }));
  if (failure) throw failure.error;
  if (cleanupError) throw cleanupError;
}

/**
 * Consumes the claim adapter's verified in-memory inputs. The caller owns the lease and must
 * dispose before releasing it. No worker credential, grant URL or host path enters the engine.
 */
export async function createClaimImageInputs(prepared, isLeaseActive) {
  assert.equal(typeof isLeaseActive, 'function', 'LEASE_CHECK_REQUIRED');
  assert.ok(isLeaseActive(), 'LEASE_LOST');
  assert.ok(prepared.operationId && prepared.claimToken && prepared.revisionId, 'CLAIM_BINDING_REQUIRED');
  const project = structuredClone(prepared.snapshot?.studio?.graph);
  assert.ok(project?.metadata && project.timeline && Array.isArray(project.timeline.items), 'PROJECT_REQUIRED');
  for (const key of ['width', 'height', 'fps']) {
    assert.ok(Number.isFinite(project.metadata[key]) && project.metadata[key] > 0, 'PROJECT_CADENCE_REQUIRED');
  }
  const views = timelineViews(project);
  const items = views.flatMap((view) => view.items);
  for (const item of items) {
    assert.ok(
      ((['image', 'video', 'lottie'].includes(item.type) && typeof item.mediaId === 'string') ||
        (item.type === 'shape' && !item.mediaId) ||
        (item.type === 'composition' && typeof item.compositionId === 'string' && !item.mediaId)) &&
        !item.generatedId && !item.src && !item.audioSrc,
      'IMAGE_SOURCE_ADAPTER_ONLY',
    );
  }

  // Bind the exact prepared source used by the resolver/server, not a historical manifest alone.
  const configuration = JSON.parse(await readFile(path.join(studio, 'engine-build.json'), 'utf8'));
  const source = await inventory(
    engine,
    '',
    new Set(['node_modules', 'dist', 'frameleaf-source.json', 'frameleaf-build.json']),
  );
  assert.equal(sha256(JSON.stringify(source)), configuration.sourceSha256, 'PREPARED_ENGINE_CHANGED');
  const require = createRequire(path.join(engine, 'package.json'));
  const { tsImport } = require('tsx/esm/api');
  const { extractStudioResourceReferences, checkNestedSequences, measureStudioGraph, STUDIO_MAX_GRAPH_BYTES } = await tsImport(
    path.join(studio, '../server/src/utils/studio-resources.ts'),
    { parentURL: import.meta.url, tsconfig: false },
  );
  assert.ok(measureStudioGraph(project) <= STUDIO_MAX_GRAPH_BYTES, 'GRAPH_RESOURCE_LIMIT');
  const extraction = extractStudioResourceReferences(project);
  // Match the existing server's legacy clip import mapping, never an explicit dependency kind.
  for (const reference of extraction.references) {
    if (!reference.vectorDependency && reference.kind === 'library-asset' &&
        prepared.snapshot.studio.resources.some(entry => entry.kind === 'project-import' && entry.id === reference.id)) reference.kind = 'project-import';
  }
  extraction.references = extraction.references.filter((reference, index, list) =>
    list.findIndex(other => other.kind === reference.kind && other.id === reference.id && other.family === reference.family) === index);
  validateClaimResourceClosure(prepared, extraction);
  assert.equal(checkNestedSequences(extraction.sequences).refused.length, 0, 'INVALID_GRAPH_RESOURCE');
  validateInlineLuts(project);
  const fileLuts = await deriveClaimFileLuts(prepared, isLeaseActive);
  let vectors = { sources: [], resources: [], digest: null };
  const sources = [];
  let folder;
  const paths = new Map();
  let server;
  let harness;
  let pool;
  let leaseTimer;
  const abort = new AbortController();
  const hdrRasters = {};
  const hdrRasterFiles = [];
  const videoInputs = [];
  let retainedPixels = 0;
  let disposed = false;
  const dispose = async (failure) => {
    if (disposed) {
      if (failure) throw failure.error;
      return;
    }
    disposed = true;
    abort.abort(new Error('LEASE_LOST'));
    clearInterval(leaseTimer);
    paths.clear();
    await disposeClaimImageResources({ pool, sources, vectors, hdrRasters, harness, server, folder }, failure);
  };
  try {
    vectors = await deriveClaimVectors(prepared, isLeaseActive);
    const { collectMediaIds } = await import(pathToFileURL(path.join(engine, 'headless/lib/workspace.mjs')).href);
    const { createMediaServer } = await import(pathToFileURL(path.join(engine, 'headless/media-server.mjs')).href);
    // Include unused definitions as well as every reachable/off-range occurrence. The same
    // existing collector discovers the bytes; the server extraction remains grant authority.
    const ids = [...new Set(views.flatMap((view) => collectMediaIds({
      ...project, timeline: { ...project.timeline, items: view.items },
    })))];
    assert.ok(
      extraction.references.every((reference) =>
        (reference.kind === 'library-asset' && ids.includes(reference.id)) ||
        (reference.kind === 'nested-sequence' && extraction.sequences.has(reference.id)) ||
        (reference.kind === 'lut' && fileLuts.binding.resources.some(resource => resource.key === `lut:${reference.id}`)) ||
        vectors.resources.includes(`${reference.kind}:${reference.id}`)),
      'UNSUPPORTED_GRAPH_RESOURCE',
    );
    const rasterIds = ids.filter(id => !vectors.sources.some(source => source.id === id));
    const consumed = new Set([...rasterIds.map(id => `library-asset:${id}`), ...fileLuts.binding.resources.map(resource => resource.key), ...vectors.resources]);
    assert.equal(prepared.inputs.size, consumed.size, 'UNSUPPORTED_OR_UNUSED_RESOURCE');
    sources.push(...rasterIds.map((id) => {
      const input = prepared.inputs.get(`library-asset:${id}`);
      assert.ok(
        input?.kind === 'library-asset' && input.resourceId === id && Buffer.isBuffer(input.bytes),
        'AUTHORIZED_IMAGE_INPUT_REQUIRED',
      );
      assert.equal(sha256(input.bytes), input.sha256, 'VERIFIED_INPUT_CHANGED');
      const uses = new Set(items.filter((item) => item.mediaId === id).map((item) => item.type));
      assert.equal(uses.size, 1, 'MIXED_RESOURCE_USE_UNAVAILABLE');
      return { id, bytes: input.bytes, sha256: input.sha256, declaredChecksum: input.declaredChecksum, key: randomUUID(), video: uses.has('video') };
    }));
    sources.push(...vectors.sources.map(source => ({ ...source, key: randomUUID(), vector: true })));
    assert.ok(sources.reduce((total, source) => total + source.bytes.length, 0) <= 32 * 1024 * 1024, 'IMAGE_BYTE_LIMIT');
    const sharp = require('sharp');
    folder = await mkdtemp(path.join(tmpdir(), 'frameleaf-claim-images-'));
    leaseTimer = setInterval(() => {
      if (!isLeaseActive()) abort.abort(new Error('LEASE_LOST'));
    }, 50);
    leaseTimer.unref();
    for (const source of sources) source.bytes = Buffer.from(source.bytes);
    for (const source of sources) {
      assert.ok(isLeaseActive(), 'LEASE_LOST');
      if (source.vector) {
        const file = path.join(folder, `${source.key}.json`);
        await writeFile(file, source.bytes, { mode: 0o600, flag: 'wx' });
        paths.set(source.key, file);
        continue;
      }
      if (source.video) {
        source.format = 'mp4';
        const file = path.join(folder, `${source.key}.mp4`);
        const observed = await inspectVerifiedVideo(source, file, AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]));
        assert.ok(isLeaseActive(), 'LEASE_LOST');
        retainedPixels += observed.metadata.width * observed.metadata.height;
        assert.ok(retainedPixels <= 64_000_000, 'IMAGE_RASTER_RESOURCE_LIMIT');
        source.metadata = observed.metadata;
        videoInputs.push(observed);
        paths.set(source.key, file);
        continue;
      }
      const validated = await validateStillImage(source.bytes, sharp);
      source.format = validated.format;
      source.metadata = {
        id: source.id, storageType: 'workspace', fileName: `${source.key}.${validated.format}`,
        fileSize: source.bytes.length, mimeType: validated.format === 'jpeg' ? 'image/jpeg' : `image/${validated.format}`,
        duration: 0, width: validated.width ?? 0, height: validated.height ?? 0,
        fps: 0, codec: validated.format, bitrate: 0,
      };
      let sourcePixels = validated.width * validated.height;
      if (Number.isSafeInteger(sourcePixels)) {
        retainedPixels += sourcePixels;
        assert.ok(retainedPixels <= 64_000_000, 'IMAGE_RASTER_RESOURCE_LIMIT');
      }
      if (source.format === 'hdr-png') {
        assert.ok(process.env.FRAMELEAF_HDR_IMAGES === 'experimental', 'HDR_IMAGE_PROCESSING_DISABLED');
        const decoded = await decodeHdrRaster(source.bytes, sharp, abort.signal);
        hdrRasters[source.id] = decoded;
        source.format = 'png';
        source.metadata = undefined; // Owned linear raster metadata is carried by the HDR contract.
      }
      if (source.format === 'jpeg' || source.format === 'heif') {
        if (!pool) {
          const { SharpProcessPool } = await import(new URL('../../server/dist/queue/sharp-pool.js', import.meta.url));
          pool = new SharpProcessPool({ workers: 1, pending: 0, maxPixels: 48_000_000, maxBytes: 6 * 1024 ** 3 });
        }
        const encoding = await pool.run('inspectImageEncoding', [source.bytes], abort.signal);
        source.metadata.width = encoding.width;
        source.metadata.height = encoding.height;
        if (source.format === 'heif') {
          sourcePixels = encoding.width * encoding.height;
          assert.ok(
            Number.isSafeInteger(sourcePixels) && sourcePixels > 0 && sourcePixels <= 48_000_000,
            'IMAGE_PIXEL_LIMIT',
          );
          retainedPixels += sourcePixels;
          assert.ok(retainedPixels <= 64_000_000, 'IMAGE_RASTER_RESOURCE_LIMIT');
        }
        if (encoding.dynamicRange === 'hdr') {
          assert.ok(process.env.FRAMELEAF_HDR_IMAGES === 'experimental', 'HDR_IMAGE_PROCESSING_DISABLED');
          assert.ok(encoding.reconstructionAvailable, 'HDR_RECONSTRUCTION_UNAVAILABLE');
          assert.ok(
            Number.isSafeInteger(encoding.width) &&
              Number.isSafeInteger(encoding.height) &&
              encoding.width > 0 &&
              encoding.height > 0 &&
              retainedPixels <= 64_000_000,
            'HDR_RASTER_RESOURCE_LIMIT',
          );
          const decoded = await pool.run('decodeHdrImage', [source.bytes], abort.signal);
          try {
            assert.equal(decoded.width * decoded.height, sourcePixels, 'HDR_RASTER_DIMENSIONS_CHANGED');
            hdrRasters[source.id] = {
              width: decoded.width,
              height: decoded.height,
              transfer: 'linear',
              rgba: new Float32Array(
                decoded.data.buffer.slice(decoded.data.byteOffset, decoded.data.byteOffset + decoded.data.length),
              ),
              gamut: decoded.gamut,
              referenceWhite: decoded.referenceWhite,
            };
          } finally {
            decoded.data.fill(0);
          }
          const preview = path.join(folder, `${source.key}.jpeg`);
          await pool.run(
            'generateHdrRenditions',
            [source.bytes, [{ path: preview, dynamicRange: 'sdr', size: 2048 }]],
            abort.signal,
          );
          assert.ok(isLeaseActive(), 'LEASE_LOST');
          source.metadata = undefined; // The derived photo preview uses its existing HDR raster contract.
          paths.set(source.key, preview);
          continue;
        }
        if (source.format === 'heif') {
          assert.equal(encoding.dynamicRange, 'sdr', 'HEIF_COLOR_UNAVAILABLE');
          const preview = path.join(folder, `${source.key}.png`);
          await pool.run('writeStrippedStill', [source.bytes, preview, 'png', 'srgb'], abort.signal);
          assert.ok(isLeaseActive(), 'LEASE_LOST');
          source.metadata = undefined; // The derived photo preview uses its existing HDR raster contract.
          paths.set(source.key, preview);
          continue;
        }
      }
      // Generated filenames only, with the actually decoded format for the media server MIME type.
      const file = path.join(folder, `${source.key}.${source.format}`);
      await writeFile(file, source.bytes, { mode: 0o600, flag: 'wx' });
      paths.set(source.key, file);
    }
    for (const [id, raster] of Object.entries(hdrRasters)) {
      assert.ok(isLeaseActive(), 'LEASE_LOST');
      const { rgba, rgb, ...metadata } = raster;
      const pixels = rgba ?? rgb;
      const bytes = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      const key = randomUUID();
      const file = path.join(folder, `${key}.bin`);
      await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      paths.set(key, file);
      hdrRasterFiles.push({ id, key, ...metadata, byteLength: bytes.length, sha256: sha256(bytes) });
    }
    const videoTiming = reconcileVideoTiming(project, prepared.snapshot.timing, videoInputs);
    clearInterval(leaseTimer);
    await pool?.close();
    server = await createMediaServer((key) => (!disposed && isLeaseActive() ? (paths.get(key) ?? null) : null));
    assert.ok(isLeaseActive(), 'LEASE_LOST');
    return {
      binding: { operationId: prepared.operationId, claimToken: prepared.claimToken, revisionId: prepared.revisionId },
      sourceSha256: configuration.sourceSha256,
      videoTiming,
      videoInputs,
      fileLuts,
      vectors,
      // This is the existing headless payload fragment. The graph is preserved without migration
      // or guessed settings. Each opaque local URL serves only a verified, grant-bound input.
      input: {
        project,
        media: sources.map(({ id, key, metadata }) => ({ mediaId: id, url: server.url(key), metadata })),
        ...(Object.keys(hdrRasters).length && { hdrRasters }),
        strict: true,
      },
      // Same-origin media is required by the built harness CSP. Keep private paths inside
      // this lease-bound adapter and reuse Freecut's existing static/Range server.
      createHarness: async () => {
        assert.ok(!harness && !disposed && isLeaseActive(), 'LEASE_LOST');
        const { createHarnessServer } = await import(pathToFileURL(path.join(engine, 'headless/server.mjs')).href);
        harness = await createHarnessServer({
          distDir: path.join(engine, 'dist'),
          resolveMedia: (key) => (!disposed && isLeaseActive() ? (paths.get(key) ?? null) : null),
        });
        return {
          harnessUrl: harness.harnessUrl,
          ...(Object.keys(hdrRasters).length && { hdrRasters }),
          hdrRasterResources: hdrRasterFiles.map(({ key, ...metadata }) => ({
            ...metadata,
            url: harness.mediaUrl(key),
          })),
          media: sources.map(({ id, key, metadata }) => ({ mediaId: id, url: harness.mediaUrl(key), metadata })),
        };
      },
      dispose,
    };
  } catch (error) {
    await dispose({ error });
    throw error;
  }
}
