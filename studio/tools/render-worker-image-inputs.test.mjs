import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createClaimImageInputs } from './render-worker-image-inputs.mjs';

// An input specimen, never an asserted render output. The test uses the prepared engine's real
// collectMediaIds and media server, including its Range handling; no renderer is mocked.
const sharp = createRequire(new URL('../engine/package.json', import.meta.url))('sharp');
const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } })
  .png()
  .toBuffer();
const mediaId = '11111111-1111-4111-8111-111111111111';
const prepared = () => ({
  operationId: randomUUID(),
  claimToken: randomUUID(),
  revisionId: 'immutable-revision-7',
  snapshot: {
    studio: {
      stored: true,
      revision: 7,
      graph: {
        id: 'project',
        name: 'Image specimen',
        description: '',
        createdAt: 0,
        updatedAt: 0,
        duration: 1,
        metadata: { width: 32, height: 32, fps: 24 },
        timeline: {
          tracks: [
            {
              id: 'v1',
              name: 'V1',
              kind: 'video',
              height: 80,
              locked: false,
              visible: true,
              muted: false,
              solo: false,
              order: 0,
            },
          ],
          items: [{ id: 'clip', type: 'image', mediaId, trackId: 'v1', from: 0, durationInFrames: 24 }],
          transitions: [],
          keyframes: [],
        },
      },
    },
  },
  inputs: new Map([
    [
      `library-asset:${mediaId}`,
      {
        resourceId: mediaId,
        kind: 'library-asset',
        bytes: Buffer.from(png),
        sha256: createHash('sha256').update(png).digest('hex'),
      },
    ],
  ]),
});

test('real Freecut input contract preserves graph and serves only bound bytes while lease is live', async () => {
  const claim = prepared();
  const original = structuredClone(claim.snapshot.studio.graph);
  let live = true;
  const adapted = await createClaimImageInputs(claim, () => live);
  const url = adapted.input.media[0].url;
  try {
    assert.deepEqual(adapted.input.project, original);
    assert.notEqual(adapted.input.project, claim.snapshot.studio.graph);
    assert.deepEqual(adapted.binding, {
      operationId: claim.operationId,
      claimToken: claim.claimToken,
      revisionId: claim.revisionId,
    });
    assert.equal(adapted.input.media[0].mediaId, mediaId);
    assert.equal(adapted.input.strict, true);
    assert.ok(!url.includes(mediaId) && !url.includes(claim.claimToken));
    assert.equal(new URL(url).hostname, '127.0.0.1');
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    const partial = await fetch(url, { headers: { Range: 'bytes=0-7' } });
    assert.equal(partial.status, 206);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), png.subarray(0, 8));
    const unbound = new URL(`/media/${mediaId}`, url);
    const denied = await fetch(unbound);
    assert.equal(denied.status, 404);
    await denied.arrayBuffer();
    live = false;
    const revoked = await fetch(url);
    assert.equal(revoked.status, 404);
    await revoked.arrayBuffer();
    assert.deepEqual(claim.snapshot.studio.graph, original);
  } finally {
    await adapted.dispose();
  }
  await assert.rejects(fetch(url));
  await adapted.dispose();
});

test('cannot rebind verified bytes or substitute another resource identity', async () => {
  const changed = prepared();
  changed.inputs.get(`library-asset:${mediaId}`).bytes[0] ^= 1;
  await assert.rejects(
    createClaimImageInputs(changed, () => true),
    /VERIFIED_INPUT_CHANGED/,
  );
  const substituted = prepared();
  substituted.inputs.get(`library-asset:${mediaId}`).resourceId = 'another-asset';
  await assert.rejects(
    createClaimImageInputs(substituted, () => true),
    /AUTHORIZED_IMAGE_INPUT_REQUIRED/,
  );
});

test('unsupported resource adapters and expired leases fail before opening source URLs', async () => {
  for (const type of ['video', 'audio', 'text', 'composition']) {
    const claim = prepared();
    claim.snapshot.studio.graph.timeline.items[0].type = type;
    await assert.rejects(
      createClaimImageInputs(claim, () => true),
      /IMAGE_SOURCE_ADAPTER_ONLY/,
    );
  }
  const linked = prepared();
  linked.snapshot.studio.graph.timeline.items[0].src = 'https://unapproved.example/source';
  await assert.rejects(
    createClaimImageInputs(linked, () => true),
    /IMAGE_SOURCE_ADAPTER_ONLY/,
  );
  await assert.rejects(
    createClaimImageInputs(prepared(), () => false),
    /LEASE_LOST/,
  );
});

test('nested non-byte resources are rejected even when every byte grant is a valid image', async () => {
  for (const nested of [
    { modelId: 'upscale-model' },
    { $resource: { kind: 'model', id: 'upscale-model' } },
    { $resource: { kind: 'preset', id: 'alpine', family: 'look' } },
    { grade: { look: 'alpine' } },
    { transitionIn: { type: 'Cross dissolve' } },
  ]) {
    const claim = prepared();
    claim.snapshot.studio.graph.timeline.items[0].effects = [{ params: { nested } }];
    await assert.rejects(
      createClaimImageInputs(claim, () => true),
      /UNSUPPORTED_GRAPH_RESOURCE/,
    );
  }
});

test('matching grant hashes do not admit text, video, malformed or incomplete image content', async () => {
  const truncated = png.subarray(0, png.length - 5);
  const corrupt = Buffer.from(png);
  corrupt[corrupt.indexOf(Buffer.from('IDAT')) + 4] ^= 0xff;
  for (const bytes of [
    Buffer.from('authorized specimen'),
    Buffer.from('....ftypisom'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    truncated,
    corrupt,
  ]) {
    const claim = prepared();
    const input = claim.inputs.get(`library-asset:${mediaId}`);
    input.bytes = bytes;
    input.sha256 = createHash('sha256').update(bytes).digest('hex');
    await assert.rejects(createClaimImageInputs(claim, () => true));
  }
});

for (const format of ['jpeg', 'heic'])
  test(
    `verified ${format} enters Studio as owned linear HDR with a separate SDR URL`,
    { skip: !process.env.FRAMELEAF_HDR_BINDING },
    async () => {
      const codec = createRequire(import.meta.url)(process.env.FRAMELEAF_HDR_BINDING);
      const pixels = new Float32Array(64 * 32 * 4);
      for (let i = 0; i < pixels.length; i += 4) pixels.set([8, 4, 2, 1], i);
      const original = codec[format === 'heic' ? 'encodeHeic' : 'encode'](
        Buffer.from(pixels.buffer),
        64,
        32,
        1,
        16_777_216,
        1024 ** 3,
      );
      const claim = prepared();
      const input = claim.inputs.get(`library-asset:${mediaId}`);
      input.bytes = Buffer.from(original);
      input.sha256 = createHash('sha256').update(original).digest('hex');
      const previous = process.env.FRAMELEAF_HDR_IMAGES;
      process.env.FRAMELEAF_HDR_IMAGES = 'experimental';
      let adapted;
      try {
        adapted = await createClaimImageInputs(claim, () => true);
        const raster = adapted.input.hdrRasters[mediaId];
        assert.equal(raster.transfer, 'linear');
        assert.equal(raster.width, 64);
        assert.equal(raster.height, 32);
        assert.equal(raster.referenceWhite, 203);
        assert.ok(raster.rgba instanceof Float32Array);
        // Pinned lossy codecs allow 0.5 reference-white units for these coloured HDR bars.
        for (let channel = 0; channel < 4; channel++)
          assert.ok(Math.abs(raster.rgba[channel] - [8, 4, 2, 1][channel]) <= 0.5);
        assert.deepEqual(input.bytes, original);
        const response = await fetch(adapted.input.media[0].url);
        assert.equal(response.headers.get('content-type'), 'image/jpeg');
        const baseline = Buffer.from(await response.arrayBuffer());
        assert.equal(codec.inspect(baseline, 16_777_216, 1024 ** 3).dynamicRange, 'sdr');
        if (process.env.FRAMELEAF_STUDIO_HDR_GPU_TEST === '1') {
          const require = createRequire(new URL('../engine/package.json', import.meta.url));
          const { chromium } = require('playwright');
          const { chromeLaunchArgs } = await import('../engine/headless/lib/cli.mjs');
          const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
          try {
            const harness = await adapted.createHarness();
            const page = await browser.newPage();
            const origin = new URL(harness.harnessUrl).origin;
            await page.route('**/*', (route) =>
              new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
            );
            await page.goto(harness.harnessUrl);
            await page.waitForFunction(() => Boolean(window.freecut?.ready));
            const measured = await page.evaluate(
              async ({ project, media, id, raster }) => {
                const adapter = await navigator.gpu?.requestAdapter();
                if (
                  !adapter ||
                  adapter.info.isFallbackAdapter ||
                  /software|swiftshader|llvmpipe/i.test(JSON.stringify(adapter.info))
                )
                  throw new Error('HARDWARE_GPU_REQUIRED');
                project.metadata.colorManagement = { workingRange: 'hdr' };
                const result = await window.freecut.renderFrameSignal({
                  project,
                  media,
                  frame: 0,
                  strict: true,
                  target: 'pq',
                  hdrRasters: { [id]: { ...raster, rgba: Float32Array.from(raster.rgba) } },
                });
                const offset = (Math.floor(result.height / 2) * result.width + Math.floor(result.width / 2)) * 4;
                return {
                  width: result.width,
                  height: result.height,
                  sample: Array.from(result.rgba.slice(offset, offset + 4)),
                };
              },
              {
                project: adapted.input.project,
                media: harness.media,
                id: mediaId,
                raster: { ...raster, rgba: Array.from(raster.rgba) },
              },
            );
            assert.equal(measured.width, 32);
            assert.equal(measured.height, 32);
            // Independent ST 2084 EOTF: the rendered signal must still exceed SDR white.
            const linear = measured.sample.slice(0, 3).map((value) => {
              const p = value ** (1 / (2523 / 32));
              return (
                ((Math.max(p - 3424 / 4096, 0) / (2413 / 128 - (2392 / 128) * p)) ** (1 / (2610 / 16384)) * 10000) / 203
              );
            });
            assert.ok(Math.max(...linear) > 6);
            assert.ok(Math.min(...linear) > 1);
            assert.ok(Math.abs(measured.sample[3] - 1) < 0.001);
          } finally {
            await browser.close();
          }
        }
        await adapted.dispose();
        assert.ok(raster.rgba.every((value) => value === 0));
        assert.deepEqual(input.bytes, original);
        delete process.env.FRAMELEAF_HDR_IMAGES;
        await assert.rejects(
          createClaimImageInputs(claim, () => true),
          /HDR_IMAGE_PROCESSING_DISABLED/,
        );
      } finally {
        await adapted?.dispose();
        if (previous === undefined) delete process.env.FRAMELEAF_HDR_IMAGES;
        else process.env.FRAMELEAF_HDR_IMAGES = previous;
      }
    },
  );

for (const format of ['sdr-jpeg', 'hdr-jpeg', 'hdr-heic', 'sdr-document', '48mp-hdr-jpeg'])
  test(
    `Studio ${format} round trip uses the real float renderer and isolated codec`,
    {
      skip:
        process.env.FRAMELEAF_STUDIO_HDR_GPU_TEST !== '1' ||
        !process.env.FRAMELEAF_HDR_BINDING ||
        (format === '48mp-hdr-jpeg' && process.env.FRAMELEAF_STUDIO_HDR_LARGE_TEST !== '1'),
      timeout: 180_000,
    },
    async () => {
      const large = format === '48mp-hdr-jpeg';
      const outputFormat = large ? 'hdr-jpeg' : format === 'sdr-document' ? 'sdr-jpeg' : format;
      const width = large ? 8000 : 32,
        height = large ? 6000 : 32;
      const sourceWidth = large ? width : 64,
        sourceHeight = large ? height : 32;
      const budget = large ? 6 * 1024 ** 3 : 1024 ** 3;
      const maxPixels = large ? 48_000_000 : 16_777_216;
      const { renderStillImage } = await import('./render-worker-still-executor.mjs');
      const { readFile } = await import('node:fs/promises');
      const codec = createRequire(import.meta.url)(process.env.FRAMELEAF_HDR_BINDING);
      const pixels = new Float32Array(sourceWidth * sourceHeight * 4);
      for (let i = 0; i < pixels.length; i += 4) pixels.set([large && i >= pixels.length / 2 ? 12 : 8, 4, 2, 1], i);
      const source =
        format === 'sdr-document'
          ? await sharp({ create: { width: 64, height: 32, channels: 3, background: '#6080c0' } })
              .png()
              .toBuffer()
          : codec.encode(
              Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
              sourceWidth,
              sourceHeight,
              2,
              maxPixels,
              budget,
            );
      const claim = prepared();
      claim.snapshot.studio.graph.metadata.width = width;
      claim.snapshot.studio.graph.metadata.height = height;
      claim.snapshot.studio.graph.metadata.colorManagement = {
        workingRange: format === 'sdr-document' ? 'sdr' : 'hdr',
      };
      claim.snapshot.contract = {
        image: {
          version: 1,
          format: outputFormat,
          width,
          height,
          frame: 0,
          dynamicRange: outputFormat === 'sdr-jpeg' ? 'sdr' : 'hdr',
          outputIntent: format === 'sdr-document' ? 'sdr' : 'hdr',
          referenceWhite: 203,
          renderer: 'frameleaf-studio-image-v1',
        },
        video: { minBitDepth: 8, transfer: null },
        audio: null,
      };
      claim.snapshot.timing = { cadence: '24/1', timeBase: '1/24', sources: [] };
      claim.settings = { format: outputFormat, color: 'preserve', resolution: 'original', audio: 'preserve' };
      const input = claim.inputs.get(`library-asset:${mediaId}`);
      input.bytes = Buffer.from(source);
      input.sha256 = createHash('sha256').update(source).digest('hex');
      const previous = process.env.FRAMELEAF_HDR_IMAGES;
      process.env.FRAMELEAF_HDR_IMAGES = 'experimental';
      let adapted;
      let live = true;
      const release = [];
      const started = performance.now();
      try {
        adapted = await createClaimImageInputs(claim, () => live);
        if (large) {
          const raster = adapted.input.hdrRasters[mediaId];
          const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
          assert.ok(raster.rgba[offset] > 6 && raster.rgba[offset + 2] > 1, 'HDR_INPUT_HEADROOM_LOST');
        }
        await renderStillImage(
          {
            claim,
            prepared: claim,
            engineInputs: adapted,
            isLeaseActive: () => live,
            elapsedMs: () => performance.now() - started,
            heartbeat: async () => {},
            registerRelease: (callback) => release.push(callback),
          },
          async ({ outputPath, checksum, sizeInBytes }) => {
            const bytes = await readFile(outputPath);
            assert.equal(createHash('sha256').update(bytes).digest('hex'), checksum);
            assert.equal(String(bytes.length), sizeInBytes);
            const encoding = codec.inspect(bytes, maxPixels, budget);
            assert.equal(encoding.dynamicRange, outputFormat === 'sdr-jpeg' ? 'sdr' : 'hdr');
            if (outputFormat === 'sdr-jpeg') {
              const metadata = await sharp(bytes).metadata();
              assert.deepEqual([metadata.width, metadata.height], [width, height]);
              assert.ok(!metadata.exif && !metadata.xmp);
              if (format === 'sdr-document') {
                const rgb = await sharp(bytes).raw().removeAlpha().toBuffer();
                const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 3;
                for (let channel = 0; channel < 3; channel++)
                  assert.ok(Math.abs(rgb[offset + channel] - [96, 128, 192][channel]) <= 4, 'SDR_APPEARANCE_CHANGED');
                rgb.fill(0);
              }
            } else {
              const decoded = codec.decode(bytes, maxPixels, budget);
              const rgb = new Float32Array(
                decoded.data.buffer.slice(decoded.data.byteOffset, decoded.data.byteOffset + decoded.data.length),
              );
              const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
              assert.ok(
                Math.max(...rgb.slice(offset, offset + 3)) > 6,
                `HDR_HEADROOM_LOST: ${Array.from(rgb.slice(offset, offset + 4))}`,
              );
              assert.ok(
                Math.min(...rgb.slice(offset, offset + 3)) > 1,
                `HDR_HEADROOM_LOST: ${Array.from(rgb.slice(offset, offset + 3))}`,
              );
              if (large) {
                for (const [row, red] of [
                  [0, 8],
                  [height - 1, 12],
                ]) {
                  const offset = (row * width + Math.floor(width / 2)) * 4;
                  assert.ok(Math.abs(rgb[offset] - red) < 1, 'HDR_READBACK_ROWS_CHANGED');
                }
              }
              rgb.fill(0);
              decoded.data.fill(0);
            }
            bytes.fill(0);
          },
        );
        assert.deepEqual(input.bytes, source);
        if (large) {
          const secondId = '00000000-0000-4000-8000-000000000002';
          claim.snapshot.studio.graph.timeline.items.push({
            ...claim.snapshot.studio.graph.timeline.items[0],
            id: 'clip2',
            mediaId: secondId,
          });
          claim.inputs.set(`library-asset:${secondId}`, { ...input, resourceId: secondId });
          await assert.rejects(
            createClaimImageInputs(claim, () => live),
            /IMAGE_RASTER_RESOURCE_LIMIT/,
          );
          assert.deepEqual(input.bytes, source);
        }
      } finally {
        live = false;
        for (const callback of release) await callback();
        await adapted?.dispose();
        pixels.fill(0);
        source.fill(0);
        if (previous === undefined) delete process.env.FRAMELEAF_HDR_IMAGES;
        else process.env.FRAMELEAF_HDR_IMAGES = previous;
      }
    },
  );
