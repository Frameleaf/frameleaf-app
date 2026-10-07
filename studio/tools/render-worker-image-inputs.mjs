// FL-145: the still-image subset of Freecut's HeadlessProjectInput/HeadlessFrameInput.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventory } from './engine.mjs';
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
  if (format === 'heif') return format;
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
  const decoder = sharp(bytes, { limitInputPixels: 16_777_216, failOn: 'warning', animated: true }).timeout({
    seconds: 5,
  });
  try {
    const metadata = await decoder.metadata();
    assert.equal(metadata.format, format, 'IMAGE_FORMAT_MISMATCH');
    assert.equal(metadata.pages ?? 1, 1, 'ANIMATED_IMAGE_UNSUPPORTED');
    assert.ok(
      metadata.width > 0 && metadata.height > 0 && metadata.width * metadata.height <= 16_777_216,
      'IMAGE_PIXEL_LIMIT',
    );
    // Metadata/signatures alone do not prove a complete image. Decode all pixels, then discard
    // the validation buffer; the original verified source bytes are what the renderer receives.
    const decoded = await decoder.raw().toBuffer();
    decoded.fill(0);
    return hdrPng ? 'hdr-png' : format;
  } finally {
    decoder.destroy();
  }
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
  // Video/audio need measured metadata for codec selection and source cadence. Generated media,
  // fonts, models, LUTs and nested compositions need their own resource adapters; never ignore them.
  assert.ok(!project.timeline.compositions?.length, 'NESTED_COMPOSITION_ADAPTER_UNAVAILABLE');
  for (const item of project.timeline.items) {
    assert.ok(
      ((item.type === 'image' && typeof item.mediaId === 'string') || (item.type === 'shape' && !item.mediaId)) &&
        !item.generatedId &&
        !item.src &&
        !item.audioSrc,
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
  const { extractStudioResourceReferences, measureStudioGraph, STUDIO_MAX_GRAPH_BYTES } = await tsImport(
    path.join(studio, '../server/src/utils/studio-resources.ts'),
    { parentURL: import.meta.url, tsconfig: false },
  );
  assert.ok(measureStudioGraph(project) <= STUDIO_MAX_GRAPH_BYTES, 'GRAPH_RESOURCE_LIMIT');
  const extraction = extractStudioResourceReferences(project);
  assert.equal(extraction.violations.length, 0, 'INVALID_GRAPH_RESOURCE');
  const { collectMediaIds } = await import(pathToFileURL(path.join(engine, 'headless/lib/workspace.mjs')).href);
  const { createMediaServer } = await import(pathToFileURL(path.join(engine, 'headless/media-server.mjs')).href);
  const ids = collectMediaIds(project);
  assert.ok(
    extraction.references.every((reference) => reference.kind === 'library-asset' && ids.includes(reference.id)),
    'UNSUPPORTED_GRAPH_RESOURCE',
  );
  assert.equal(prepared.inputs.size, ids.length, 'UNSUPPORTED_OR_UNUSED_RESOURCE');
  const sources = ids.map((id) => {
    const input = prepared.inputs.get(`library-asset:${id}`);
    assert.ok(
      input?.kind === 'library-asset' && input.resourceId === id && Buffer.isBuffer(input.bytes),
      'AUTHORIZED_IMAGE_INPUT_REQUIRED',
    );
    assert.equal(sha256(input.bytes), input.sha256, 'VERIFIED_INPUT_CHANGED');
    return { id, bytes: input.bytes, key: randomUUID() };
  });
  assert.ok(sources.reduce((total, source) => total + source.bytes.length, 0) <= 32 * 1024 * 1024, 'IMAGE_BYTE_LIMIT');
  const sharp = require('sharp');
  const folder = await mkdtemp(path.join(tmpdir(), 'frameleaf-claim-images-'));
  const paths = new Map();
  let server;
  let harness;
  let pool;
  let leaseTimer;
  const abort = new AbortController();
  const hdrRasters = {};
  const hdrRasterFiles = [];
  let retainedPixels = 0;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    abort.abort(new Error('LEASE_LOST'));
    clearInterval(leaseTimer);
    paths.clear();
    try {
      await pool?.close();
      for (const source of sources) source.bytes.fill(0);
      for (const raster of Object.values(hdrRasters)) {
        raster.rgba?.fill(0);
        raster.rgb?.fill(0);
      }
      await harness?.close();
      await server?.close();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };
  try {
    leaseTimer = setInterval(() => {
      if (!isLeaseActive()) abort.abort(new Error('LEASE_LOST'));
    }, 50);
    leaseTimer.unref();
    for (const source of sources) source.bytes = Buffer.from(source.bytes);
    for (const source of sources) {
      assert.ok(isLeaseActive(), 'LEASE_LOST');
      source.format = await validateStillImage(source.bytes, sharp);
      if (source.format === 'hdr-png') {
        assert.ok(process.env.FRAMELEAF_HDR_IMAGES === 'experimental', 'HDR_IMAGE_PROCESSING_DISABLED');
        const decoded = await decodeHdrRaster(source.bytes, sharp, abort.signal);
        retainedPixels += decoded.width * decoded.height;
        if (retainedPixels > 16_777_216) {
          decoded.rgb.fill(0);
          throw new Error('HDR_RASTER_RESOURCE_LIMIT');
        }
        hdrRasters[source.id] = decoded;
        source.format = 'png';
      }
      if (source.format === 'jpeg' || source.format === 'heif') {
        if (!pool) {
          const { SharpProcessPool } = await import(new URL('../../server/dist/queue/sharp-pool.js', import.meta.url));
          pool = new SharpProcessPool({ workers: 1, pending: 0, maxPixels: 16_777_216 });
        }
        const encoding = await pool.run('inspectImageEncoding', [source.bytes], abort.signal);
        if (encoding.dynamicRange === 'hdr') {
          assert.ok(process.env.FRAMELEAF_HDR_IMAGES === 'experimental', 'HDR_IMAGE_PROCESSING_DISABLED');
          assert.ok(encoding.reconstructionAvailable, 'HDR_RECONSTRUCTION_UNAVAILABLE');
          assert.ok(
            Number.isSafeInteger(encoding.width) &&
              Number.isSafeInteger(encoding.height) &&
              encoding.width > 0 &&
              encoding.height > 0 &&
              retainedPixels + encoding.width * encoding.height <= 16_777_216,
            'HDR_RASTER_RESOURCE_LIMIT',
          );
          const decoded = await pool.run('decodeHdrImage', [source.bytes], abort.signal);
          try {
            retainedPixels += decoded.width * decoded.height;
            assert.ok(retainedPixels <= 16_777_216, 'HDR_RASTER_RESOURCE_LIMIT');
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
          paths.set(source.key, preview);
          continue;
        }
        if (source.format === 'heif') {
          assert.equal(encoding.dynamicRange, 'sdr', 'HEIF_COLOR_UNAVAILABLE');
          const preview = path.join(folder, `${source.key}.png`);
          await pool.run('writeStrippedStill', [source.bytes, preview, 'png', 'srgb'], abort.signal);
          assert.ok(isLeaseActive(), 'LEASE_LOST');
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
    clearInterval(leaseTimer);
    await pool?.close();
    server = await createMediaServer((key) => (!disposed && isLeaseActive() ? (paths.get(key) ?? null) : null));
    assert.ok(isLeaseActive(), 'LEASE_LOST');
    return {
      binding: { operationId: prepared.operationId, claimToken: prepared.claimToken, revisionId: prepared.revisionId },
      sourceSha256: configuration.sourceSha256,
      // This is the existing headless payload fragment. The graph is preserved without migration
      // or guessed settings. Each opaque local URL serves only a verified, grant-bound input.
      input: {
        project,
        media: sources.map(({ id, key }) => ({ mediaId: id, url: server.url(key) })),
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
          media: sources.map(({ id, key }) => ({ mediaId: id, url: harness.mediaUrl(key) })),
        };
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
