// FL-145: verified images and intrinsic rectangles in Freecut's headless input contract.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventory } from './engine.mjs';

const studio = fileURLToPath(new URL('../', import.meta.url));
const engine = path.join(studio, 'engine');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function validateStillImage(bytes, sharp) {
  assert.ok(bytes.length <= 32 * 1024 * 1024, 'IMAGE_BYTE_LIMIT');
  // Reject non-raster formats before invoking a decoder (SVG may contain external resources).
  const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
  assert.ok(format, 'UNSUPPORTED_IMAGE_CONTENT');
  // libvips can expose only the first APNG frame. Refuse animation instead of silently flattening it.
  if (format === 'png') {
    for (let offset = 8; offset < bytes.length;) {
      assert.ok(offset + 12 <= bytes.length, 'INVALID_IMAGE_CONTENT');
      const length = bytes.readUInt32BE(offset);
      assert.ok(offset + length + 12 <= bytes.length, 'INVALID_IMAGE_CONTENT');
      assert.notEqual(bytes.toString('ascii', offset + 4, offset + 8), 'acTL', 'ANIMATED_IMAGE_UNSUPPORTED');
      offset += length + 12;
    }
  }
  const decoder = sharp(bytes, { limitInputPixels: 16_777_216, failOn: 'warning', animated: true })
    .timeout({ seconds: 5 });
  try {
    const metadata = await decoder.metadata();
    assert.equal(metadata.format, format, 'IMAGE_FORMAT_MISMATCH');
    assert.equal(metadata.pages ?? 1, 1, 'ANIMATED_IMAGE_UNSUPPORTED');
    assert.ok(metadata.width > 0 && metadata.height > 0 && metadata.width * metadata.height <= 16_777_216,
      'IMAGE_PIXEL_LIMIT');
    // Metadata/signatures alone do not prove a complete image. Decode all pixels, then discard
    // the validation buffer; the original verified source bytes are what the renderer receives.
    const decoded = await decoder.raw().toBuffer();
    decoded.fill(0);
    return format;
  } finally { decoder.destroy(); }
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
    assert.ok(((item.type === 'image' && typeof item.mediaId === 'string') ||
      (item.type === 'shape' && item.shapeType === 'rectangle' && !item.mediaId)) &&
      !item.generatedId && !item.src && !item.audioSrc, 'IMAGE_SOURCE_ADAPTER_ONLY');
  }

  // Bind the exact prepared source used by the resolver/server, not a historical manifest alone.
  const configuration = JSON.parse(await readFile(path.join(studio, 'engine-build.json'), 'utf8'));
  const source = await inventory(engine, '', new Set(['node_modules', 'dist', 'frameleaf-source.json', 'frameleaf-build.json']));
  assert.equal(sha256(JSON.stringify(source)), configuration.sourceSha256, 'PREPARED_ENGINE_CHANGED');
  const require = createRequire(path.join(engine, 'package.json'));
  const { tsImport } = require('tsx/esm/api');
  const { extractStudioResourceReferences, measureStudioGraph, STUDIO_MAX_GRAPH_BYTES } = await tsImport(
    path.join(studio, '../server/src/utils/studio-resources.ts'), { parentURL: import.meta.url, tsconfig: false });
  assert.ok(measureStudioGraph(project) <= STUDIO_MAX_GRAPH_BYTES, 'GRAPH_RESOURCE_LIMIT');
  const extraction = extractStudioResourceReferences(project);
  assert.equal(extraction.violations.length, 0, 'INVALID_GRAPH_RESOURCE');
  const { collectMediaIds } = await import(pathToFileURL(path.join(engine, 'headless/lib/workspace.mjs')).href);
  const { createMediaServer } = await import(pathToFileURL(path.join(engine, 'headless/media-server.mjs')).href);
  const ids = collectMediaIds(project);
  assert.ok(extraction.references.every((reference) => reference.kind === 'library-asset' && ids.includes(reference.id)),
    'UNSUPPORTED_GRAPH_RESOURCE');
  assert.equal(prepared.inputs.size, ids.length, 'UNSUPPORTED_OR_UNUSED_RESOURCE');
  const sources = ids.map((id) => {
    const input = prepared.inputs.get(`library-asset:${id}`);
    assert.ok(input?.kind === 'library-asset' && input.resourceId === id && Buffer.isBuffer(input.bytes),
      'AUTHORIZED_IMAGE_INPUT_REQUIRED');
    assert.equal(sha256(input.bytes), input.sha256, 'VERIFIED_INPUT_CHANGED');
    return { id, bytes: input.bytes, key: randomUUID() };
  });
  const sharp = require('sharp');
  for (const source of sources) {
    assert.ok(isLeaseActive(), 'LEASE_LOST');
    source.format = await validateStillImage(source.bytes, sharp);
  }

  const folder = await mkdtemp(path.join(tmpdir(), 'frameleaf-claim-images-'));
  const paths = new Map();
  let server;
  let harness;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    paths.clear();
    try { await harness?.close(); await server?.close(); } finally { await rm(folder, { recursive: true, force: true }); }
  };
  try {
    for (const source of sources) {
      assert.ok(isLeaseActive(), 'LEASE_LOST');
      // Generated filenames only, with the actually decoded format for the media server MIME type.
      const file = path.join(folder, `${source.key}.${source.format}`);
      await writeFile(file, source.bytes, { mode: 0o600, flag: 'wx' });
      paths.set(source.key, file);
    }
    server = await createMediaServer((key) => !disposed && isLeaseActive() ? paths.get(key) ?? null : null);
    assert.ok(isLeaseActive(), 'LEASE_LOST');
    return {
      binding: { operationId: prepared.operationId, claimToken: prepared.claimToken, revisionId: prepared.revisionId },
      sourceSha256: configuration.sourceSha256,
      // This is the existing headless payload fragment. The graph is preserved without migration
      // or guessed settings. Each opaque local URL serves only a verified, grant-bound input.
      input: { project, media: sources.map(({ id, key }) => ({ mediaId: id, url: server.url(key) })), strict: true },
      // Same-origin media is required by the built harness CSP. Keep private paths inside
      // this lease-bound adapter and reuse Freecut's existing static/Range server.
      createHarness: async () => {
        assert.ok(!harness && !disposed && isLeaseActive(), 'LEASE_LOST');
        const { createHarnessServer } = await import(pathToFileURL(path.join(engine, 'headless/server.mjs')).href);
        harness = await createHarnessServer({ distDir: path.join(engine, 'dist'),
          resolveMedia: (key) => !disposed && isLeaseActive() ? paths.get(key) ?? null : null });
        return { harnessUrl: harness.harnessUrl,
          media: sources.map(({ id, key }) => ({ mediaId: id, url: harness.mediaUrl(key) })) };
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
