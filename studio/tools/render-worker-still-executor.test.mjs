import assert from 'node:assert/strict';
import test from 'node:test';
import { stillRecipe, renderStillImage, ownedOutputBytes } from './render-worker-still-executor.mjs';
const claim = () => ({
  settings: { format: 'mp4-h264', color: 'preserve', resolution: '720p', audio: 'preserve' },
  snapshot: {
    studio: {
      graph: {
        id: 'p',
        duration: 1,
        metadata: { width: 1280, height: 720, fps: 24 },
        timeline: {
          tracks: [{ id: 'v1', kind: 'video' }],
          items: [
            {
              id: 'clip',
              type: 'image',
              mediaId: 'asset',
              trackId: 'v1',
              from: 0,
              durationInFrames: 24,
            },
          ],
          transitions: [],
          keyframes: [],
        },
      },
    },
    contract: { video: { minBitDepth: 8, transfer: null }, audio: null },
    timing: { cadence: '24/1', timeBase: '1/24', sources: [] },
  },
  limits: { maxWallClockMs: '30000', maxOutputBytes: '1048576' },
});
test('fresh one-still recipe applies stricter server ceilings and fixed measured encoder settings', () => {
  const recipe = stillRecipe(claim());
  assert.equal(recipe.frames, 24);
  assert.equal(recipe.maxMs, 30000);
  assert.equal(recipe.maxBytes, 1048576);
  assert.equal(recipe.settings.codec, 'avc');
});
test('quality presets reach the encoder, preserve the legacy default and refuse invalid presets', () => {
  assert.equal(stillRecipe(claim()).settings.quality, 'high');
  assert.equal(stillRecipe(claim()).settings.videoBitrate, 10_000_000);
  for (const [quality, bitrate] of Object.entries({
    low: 2_500_000,
    medium: 5_000_000,
    high: 10_000_000,
    ultra: 20_000_000,
  })) {
    const input = claim();
    input.settings.quality = quality;
    const { settings } = stillRecipe(input);
    assert.equal(settings.quality, quality);
    assert.equal(settings.videoBitrate, bitrate);
  }
  for (const quality of ['lossless', null, 10, {}, 'constructor']) {
    const input = claim();
    input.settings.quality = quality;
    assert.throws(() => stillRecipe(input), /UNSUPPORTED_EXPORT_QUALITY/);
  }
});
test('native subtitle modes preserve legacy settings, reject unsupported modes and preserve caption graphs for strict resource/render admission', () => {
  assert.equal(Object.hasOwn(stillRecipe(claim()).settings, 'subtitleMode'), false);
  for (const subtitleMode of ['burn', 'off']) {
    const input = claim();
    input.settings.subtitleMode = subtitleMode;
    assert.equal(stillRecipe(input).settings.subtitleMode, subtitleMode);
    input.snapshot.studio.graph.timeline.items.push({ id: 'caption', type: 'subtitle', text: 'Caption', trackId: 'v1', from: 0, durationInFrames: 24 });
    assert.equal(stillRecipe(input).frames, 24);
  }
  for (const subtitleMode of ['sidecar', 'embedded', null, 10, {}]) {
    const input = claim();
    input.settings.subtitleMode = subtitleMode;
    assert.throws(() => stillRecipe(input), /UNSUPPORTED_SUBTITLE_MODE/);
  }
});
test('ranges retain source-frame bounds, render only the selected frames and require the bound contract', () => {
  const input = claim();
  input.settings.range = { inPoint: 4, outPoint: 12 };
  input.snapshot.contract.range = { ...input.settings.range, cadence: '24/1' };
  const before = structuredClone(input);
  const recipe = stillRecipe(input);
  assert.equal(recipe.frames, 8);
  assert.deepEqual(recipe.range, { inPoint: 4, outPoint: 12 });
  assert.deepEqual(input, before);
  for (const range of [
    { inPoint: -1, outPoint: 12 },
    { inPoint: 4.5, outPoint: 12 },
    { inPoint: 12, outPoint: 12 },
    { inPoint: 4, outPoint: 25 },
    { inPoint: 4, outPoint: 12, extra: true },
    null,
  ]) {
    const invalid = structuredClone(before);
    invalid.settings.range = range;
    assert.throws(() => stillRecipe(invalid));
  }
  delete input.snapshot.contract.range;
  assert.throws(() => stillRecipe(input), /RANGE_CONTRACT_CHANGED/);
});
for (const [name, change] of [
  [
    'HDR graph',
    (c) => {
      c.snapshot.contract.video.transfer = 'smpte2084';
    },
  ],
  [
    'audio',
    (c) => {
      c.snapshot.contract.audio = { channels: 6 };
    },
  ],
  [
    'missing source timing adapter',
    (c) => {
      c.snapshot.timing.sources = [{ key: 'library-asset:asset' }];
    },
  ],
  [
    'duplicate timeline item',
    (c) => {
      c.snapshot.studio.graph.timeline.items.push(c.snapshot.studio.graph.timeline.items[0]);
    },
  ],
  [
    'invalid frame bounds',
    (c) => {
      c.snapshot.studio.graph.timeline.items[0].from = 0.5;
    },
  ],
  [
    'unbound track',
    (c) => {
      c.snapshot.studio.graph.timeline.items[0].trackId = 'missing';
    },
  ],
  [
    'export format',
    (c) => {
      c.settings.format = 'mp4-hevc-main10';
    },
  ],
  [
    'ceiling duration',
    (c) => {
      c.snapshot.studio.graph.timeline.items[0].durationInFrames = 241;
    },
  ],
  [
    'malformed ceiling',
    (c) => {
      c.limits.maxWallClockMs = '-1';
    },
  ],
  [
    'completed checkpoint recovery',
    (c) => {
      c.checkpoints = [{ state: 'completed' }];
    },
  ],
])
  test(`${name} refuses before browser or output`, () => {
    const changed = claim();
    change(changed);
    assert.throws(() => stillRecipe(changed));
  });
test('expired lease refuses before loading engine/build or creating private output', async () => {
  await assert.rejects(
    renderStillImage({ claim: claim(), isLeaseActive: () => false }, () => assert.fail()),
    /LEASE_LOST/,
  );
});

test('still image recipes preserve explicit document intent and one frame without accepting video settings', () => {
  for (const format of ['sdr-jpeg', 'hdr-jpeg', 'hdr-heic']) {
    const input = claim();
    input.settings = { format, color: 'preserve', resolution: 'original', audio: 'preserve' };
    input.snapshot.studio.graph.metadata.colorManagement = { workingRange: 'hdr' };
    input.snapshot.contract.image = {
      version: 1,
      format,
      width: 1280,
      height: 720,
      frame: 0,
      dynamicRange: format === 'sdr-jpeg' ? 'sdr' : 'hdr',
      outputIntent: 'hdr',
      referenceWhite: 203,
      renderer: 'frameleaf-studio-image-v1',
    };
    const previous = process.env.FRAMELEAF_HDR_IMAGES;
    process.env.FRAMELEAF_HDR_IMAGES = 'experimental';
    try {
      const recipe = stillRecipe(input);
      assert.equal(recipe.frames, 1);
      assert.equal(recipe.photo.format, format);
      assert.equal(recipe.photo.outputIntent, 'hdr');
      assert.equal(recipe.settings.resolution.width, 1280);
      assert.equal(recipe.maxMs, 30000);
      input.limits.maxWallClockMs = '999999';
      assert.equal(stillRecipe(input).maxMs, 180000);
      input.settings.resolution = '720p';
      assert.throws(() => stillRecipe(input), /UNSUPPORTED_STILL_EXPORT_SETTINGS/);
    } finally {
      if (previous === undefined) delete process.env.FRAMELEAF_HDR_IMAGES;
      else process.env.FRAMELEAF_HDR_IMAGES = previous;
    }
  }
});

test('immutable visual timeline recipe retains multi-item transition, keyframes and effect graph', () => {
  const input = claim();
  const graph = input.snapshot.studio.graph;
  graph.schemaVersion = 1;
  graph.timeline.items.push({ ...graph.timeline.items[0], id: 'clip-b', mediaId: 'asset-b', from: 24 });
  graph.timeline.items[0].effects = [{ id: 'fx', enabled: true, effect: { type: 'gpu-effect', gpuEffectType: 'gpu-brightness', params: { amount: 0.15 } } }];
  graph.timeline.transitions = [{ id: 'dissolve', type: 'crossfade', presentation: 'dissolve', timing: 'linear', trackId: 'v1', leftClipId: 'clip', rightClipId: 'clip-b', durationInFrames: 12 }];
  graph.timeline.keyframes = [{ itemId: 'clip', properties: [{ property: 'opacity', keyframes: [{ id: 'k0', frame: 0, value: 0, easing: 'linear' }, { id: 'k1', frame: 12, value: 1, easing: 'linear' }] }] }];
  graph.duration = 2;
  const original = structuredClone(input);
  assert.equal(stillRecipe(input).frames, 48);
  assert.deepEqual(input, original);
});


test('exact rational cadence and checkpoint ticks reuse the actual server timing helpers', () => {
  const input = claim();
  input.snapshot.studio.graph.metadata.fps = 30000 / 1001;
  input.snapshot.studio.graph.metadata.frameRate = { num: 30000, den: 1001 };
  input.snapshot.studio.graph.duration = 24 * 1001 / 30000;
  input.snapshot.timing.cadence = '30000/1001';
  input.snapshot.timing.timeBase = '1/30000';
  const result = stillRecipe(input);
  assert.equal(result.frames, 24);
  assert.equal(result.endTicks, '24024');
  assert.equal(result.timebase, '1/30000');
  assert.equal(result.settings.fps, 30000 / 1001);
  input.snapshot.timing.cadence = '24/1';
  assert.throws(() => stillRecipe(input), /PROJECT_CADENCE_CHANGED/);
});


test('whole visual timelines use explicit integer bounds even below the renderer duration floor', () => {
  const input = claim();
  input.snapshot.studio.graph.timeline.items[0].durationInFrames = 4;
  input.snapshot.studio.graph.duration = 4 / 24;
  const result = stillRecipe(input);
  assert.equal(result.frames, 4);
  assert.deepEqual(result.frameBounds, { inPoint: 0, outPoint: 4 });
  assert.equal(result.range, null);
});


test('private output accounting counts staging, deduplicates publication links and rejects traversal', async () => {
  const { mkdtemp, mkdir, writeFile, link, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-output-accounting-'));
  try {
    const staged = join(folder, '.sharp-abc123');
    await mkdir(staged);
    await writeFile(join(staged, 'output.jpg'), Buffer.alloc(13));
    await writeFile(join(folder, 'signal.bin'), Buffer.alloc(7));
    assert.equal(await ownedOutputBytes(folder), 20);
    await link(join(staged, 'output.jpg'), join(folder, 'published.jpg'));
    assert.equal(await ownedOutputBytes(folder), 20);
    await symlink(join(folder, 'signal.bin'), join(staged, 'link.jpg'));
    await assert.rejects(ownedOutputBytes(folder), /UNEXPECTED_DOWNLOAD_ENTRY/);
    await rm(join(staged, 'output.jpg'));
    await assert.rejects(ownedOutputBytes(folder), /UNEXPECTED_DOWNLOAD_ENTRY/);
    await rm(staged, { recursive: true });
    await mkdir(join(folder, 'unexpected'));
    await assert.rejects(ownedOutputBytes(folder), /UNEXPECTED_DOWNLOAD_ENTRY/);
    await rm(join(folder, 'unexpected'), { recursive: true });
    await mkdir(join(folder, '.sharp-abc123', 'nested'), { recursive: true });
    await assert.rejects(ownedOutputBytes(folder), /UNEXPECTED_DOWNLOAD_ENTRY/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('input digest mismatch refuses before engine/build/browser or private output', async () => {
  const c = claim();
  c.artifactInputDigest = 'a'.repeat(64);
  for (const prepared of [undefined, { artifactInputDigest: 'b'.repeat(64) }]) {
    await assert.rejects(renderStillImage({ claim: c, prepared, isLeaseActive: () => true,
      elapsedMs: () => 0 }, () => assert.fail()), /INPUT_DIGEST_CHANGED/);
  }
  c.artifactInputDigest = 'not-a-sha256';
  await assert.rejects(renderStillImage({ claim: c, isLeaseActive: () => true,
    elapsedMs: () => 0 }, () => assert.fail()), /INPUT_DIGEST_REQUIRED/);
});

test('terminal authority after output read clears the actual returned buffer and refuses completion', async () => {
  const { execFileSync } = await import('node:child_process');
  // Run the actual executor with controlled browser/IO boundaries; this is not hardware qualification.
  execFileSync(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import * as fs from 'node:fs/promises';
    import * as modules from 'node:module';
    import * as children from 'node:child_process';
    import { createHash } from 'node:crypto';
    const root = ${JSON.stringify(new URL('../../', import.meta.url).pathname.replace(/\/$/, ''))};
    const {default: fsDefault, ...fsNamed} = fs;
    const {default: modulesDefault, ...moduleNamed} = modules;
    const {default: childrenDefault, ...childrenNamed} = children;
    const executor = new URL('./studio/tools/render-worker-still-executor.mjs', 'file://' + root + '/');
    const engine = new URL('./studio/engine/', 'file://' + root + '/');
    const build = JSON.parse(await fs.readFile(new URL('./studio/engine-build.json', 'file://' + root + '/')));
    const bytes = Buffer.from('private-output');
    const originalError = new Error('TERMINAL_AFTER_READ');
    let terminal = false, consumed = false, closed = false;
    const report = { ...build, node: 'v' + build.node,
      artifactSha256: createHash('sha256').update('[]').digest('hex') };
    mock.module('node:fs/promises', { namedExports: { ...fsNamed,
      readFile: async file => {
        if (String(file).endsWith('engine-build.json')) return JSON.stringify(build);
        if (String(file).endsWith('frameleaf-build.json')) return JSON.stringify(report);
        assert.equal(file, '/controlled-output.mp4'); terminal = true; return bytes;
      },
      realpath: async file => file, mkdtemp: async () => '/controlled-private-folder',
      stat: async () => ({ isFile: () => true, size: bytes.length }), rm: async () => {},
    }});
    const page = { route: async () => {}, goto: async () => {}, waitForFunction: async () => {},
      evaluate: async () => ({vendor:'controlled', architecture:'test', isFallbackAdapter:false}) };
    mock.module('node:module', { namedExports: { ...moduleNamed, createRequire: base => name => {
      if (name === 'sharp') return {};
      if (name !== 'playwright') return modules.createRequire(base)(name);
      return { chromium: { launch: async () => ({ newPage: async () => page, close: async () => {closed = true;} }) } };
    } }});
    mock.module(new URL('./studio/tools/engine.mjs', 'file://' + root + '/').href,
      { namedExports: { inventory: async () => [] } });
    mock.module(new URL('./studio/tools/render-worker-vector-inputs.mjs', 'file://' + root + '/').href,
      { namedExports: { deriveClaimVectors: async () => ({digest:null, resources:[], sources:[]}) } });
    mock.module(new URL('headless/lib/cli.mjs', engine).href, { namedExports: {chromeLaunchArgs: () => []} });
    mock.module(new URL('headless/lib/render-core.mjs', engine).href, { namedExports: {
      renderJob: async (_page, input) => ({ok:true,warnings:[],effectiveSettings:input.settings,outputPath:'/controlled-output.mp4'})
    }});
    const claim = ${JSON.stringify(claim())};
    claim.artifactInputDigest = 'a'.repeat(64);
    // Avoid native ffprobe: the boundary under review is after an already validated output.
    const { mock: childMock } = await import('node:test');
    childMock.module('node:child_process', {namedExports: {...childrenNamed, execFileSync: () => JSON.stringify({
      streams:[{codec_type:'video',codec_name:'h264',width:1280,height:720,pix_fmt:'yuv420p',
        avg_frame_rate:'24/1',nb_read_frames:'24',color_transfer:'bt709',color_primaries:'bt709',
        color_space:'bt709',color_range:'tv',time_base:'1/24',start_pts:0,duration_ts:24,index:0}],
      packets:Array.from({length:24},(_,pts)=>({stream_index:0,pts,duration:1})),format:{format_name:'mp4'}
    })}});
    const {renderStillImage} = await import(executor.href);
    const context = {claim, prepared:{artifactInputDigest:claim.artifactInputDigest,inputs:new Map()},
      engineInputs:{sourceSha256:build.sourceSha256,input:{project:claim.snapshot.studio.graph,media:[]},
        binding:{operationId:claim.operationId,claimToken:claim.claimToken,revisionId:claim.revisionId},
        createHarness:async()=>({harnessUrl:'http://localhost/controlled',media:[]})},
      isLeaseActive:()=>true, heartbeat:async()=>{}, elapsedMs:()=>0, registerRelease:()=>{},
      leaseAuthority:{wait:async()=>{if(terminal) throw originalError;},isPending:()=>false,
        assertActive:()=>{},terminate:()=>{}}
    };
    await assert.rejects(renderStillImage(context, async()=>{consumed=true;}), error=>error===originalError);
    assert.deepEqual(bytes, Buffer.alloc(bytes.length));
    assert.equal(consumed,false); assert.equal(closed,true);
  `,
    ],
    { cwd: new URL('../../', import.meta.url), stdio: 'pipe' },
  );
});
