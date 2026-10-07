import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { createClaimImageInputs } from './render-worker-image-inputs.mjs';
import { hdrGraphRecipe, renderHdrGraph } from './render-worker-hdr-executor.mjs';
import { decodeMaster, validateHdrPlaneSamples } from './hdr-master.mjs';
import { publishClaimArtifact } from './render-worker-still-executor.mjs';

const specimen = () => {
  // An authored declaration for this input specimen, never a measured display or default.
  const mastering = { primaries: 'bt2020', maxNits: 4000, minNits: 0.005 };
  return {
    operationId: randomUUID(),
    claimToken: randomUUID(),
    revisionId: 'immutable-hdr-cut',
    settings: {
      format: 'mp4-hevc-main10',
      color: 'hdr10',
      resolution: '720p',
      audio: 'preserve',
      mastering,
    },
    snapshot: {
      studio: {
        revision: 7,
        graph: {
          id: 'hdr-cut',
          name: 'Authored rectangle cut',
          duration: 2 / 24,
          metadata: {
            width: 1280,
            height: 720,
            fps: 24,
            colorManagement: { workingRange: 'hdr', referenceWhiteNits: 203 },
          },
          timeline: {
            tracks: [{ id: 'v1', kind: 'video' }],
            items: [0, 1].map((from) => ({
              id: `cut-${from}`,
              type: 'shape',
              shapeType: 'rectangle',
              trackId: 'v1',
              from,
              durationInFrames: 1,
              fillColor: from ? '#336699' : 'rgb(250%, 120%, 60%)',
              strokeEnabled: false,
              strokeWidth: 0,
              transform: {
                x: 0,
                y: 0,
                width: 1280,
                height: 720,
                rotation: 0,
                opacity: 1,
              },
            })),
            transitions: [],
            keyframes: [],
          },
        },
      },
      contract: {
        video: {
          minBitDepth: 10,
          transfer: 'smpte2084',
          mastering: structuredClone(mastering),
        },
        audio: null,
      },
      timing: {
        cadence: '24/1',
        timeBase: '1/24',
        sources: [],
        decision: { mode: 'convert', cadence: '24/1' },
      },
    },
    limits: {
      maxWallClockMs: '60000',
      maxOutputBytes: String(32 * 1024 * 1024),
    },
  };
};

test('HDR rectangle-cut recipe binds the authored profile and refuses every unsupported seam', () => {
  assert.equal(hdrGraphRecipe(specimen()).frames, 2);
  for (const change of [
    (c) => {
      delete c.settings.mastering;
    },
    (c) => {
      c.settings.mastering.maxNits = 1000;
    },
    (c) => {
      c.settings.mastering.minNits = 0.00001;
      c.snapshot.contract.video.mastering.minNits = 0.00001;
    },
    (c) => {
      c.snapshot.contract.video.transfer = 'arib-std-b67';
    },
    (c) => {
      c.snapshot.contract.audio = { channels: 2 };
    },
    (c) => {
      c.settings.color = 'preserve';
    },
    (c) => {
      c.settings.quality = 'ultra';
    },
    (c) => {
      c.settings.range = { inPoint: 0, outPoint: 1 };
    },
    (c) => {
      c.snapshot.studio.graph.timeline.items[0].type = 'video';
    },
    (c) => {
      c.snapshot.studio.graph.timeline.items[0].effects = [{}];
    },
    (c) => {
      c.snapshot.studio.graph.timeline.keyframes.push({});
    },
    (c) => {
      c.snapshot.studio.graph.timeline.transitions.push({});
    },
    (c) => {
      c.snapshot.studio.graph.timeline.compositions = [{}];
    },
    (c) => {
      c.snapshot.studio.graph.timeline.items[1].from = 0;
    },
    (c) => {
      c.snapshot.studio.graph.timeline.items[0].transform.opacity = 0.5;
    },
    (c) => {
      c.snapshot.studio.graph.timeline.items[0].fillColor = 'url(https://unapproved.example)';
    },
    (c) => {
      c.snapshot.studio.graph.metadata.colorManagement.workingRange = 'sdr';
    },
    (c) => {
      c.snapshot.studio.graph.timeline.items[1].durationInFrames = 8;
    },
    (c) => {
      c.snapshot.timing.sources.push({ variableFrameRate: true });
    },
    (c) => {
      c.snapshot.timing.decision.mode = 'passthrough';
    },
    (c) => {
      c.checkpoints = [{ state: 'completed' }];
    },
    (c) => {
      c.snapshot.smoothMotion = { factor: 2 };
    },
    (c) => {
      c.limits.maxWallClockMs = '-1';
    },
  ]) {
    const claim = specimen();
    change(claim);
    assert.throws(() => hdrGraphRecipe(claim));
  }
});

test('expired lease refuses before loading the engine or creating output', async () => {
  await assert.rejects(
    renderHdrGraph({ claim: specimen(), isLeaseActive: () => false }, () => assert.fail()),
    /LEASE_LOST/,
  );
});

test('HDR staging binds the immutable graph/profile and stops at every refused protocol step', async () => {
  // Protocol-only fixture; no renderer, encoded output or admitted server is asserted here.
  const claim = { ...specimen(), artifactInputDigest: 'server-bound-input-digest' };
  const recipe = hdrGraphRecipe(claim);
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const configDigest = hash(JSON.stringify({ recipe: 'rectangle-cut-pq-v1', settings: recipe.settings }));
  const historyDigest = hash(JSON.stringify(claim.snapshot.studio.graph));
  const chunkKey = hash(`${claim.artifactInputDigest}:${configDigest}:${historyDigest}`);
  const signal = new AbortController().signal;
  const artifact = {
    outputPath: '/private/protocol-fixture.mp4',
    checksum: 'fixture-checksum',
    sizeInBytes: '123',
    signal,
    recipe,
  };
  for (const refused of [null, 'checkpoints', 'upload', 'validate', 'lease']) {
    const calls = [];
    const context = {
      claim,
      elapsedMs: () => 0,
      heartbeat: async () => {},
      isLeaseActive: () => refused !== 'lease',
      request: async (pathname, body, timeout, receivedSignal) => {
        const step = pathname.split('/').at(-1);
        calls.push(step);
        assert.equal(pathname, `/api/render-workers/operations/${claim.operationId}/${step}`);
        assert.equal(timeout, 10_000);
        assert.equal(receivedSignal, signal);
        if (step === 'checkpoints')
          assert.deepEqual(body, {
            claimToken: claim.claimToken,
            sequence: 0,
            chunkKey,
            inputDigest: claim.artifactInputDigest,
            historyDigest,
            configDigest,
            seed: null,
            timebase: '1/24',
            startTicks: '0',
            endTicks: '2',
            requiresSequentialContext: false,
          });
        else
          assert.deepEqual(body, { claimToken: claim.claimToken, artifactSequence: 0, resultAssetId: null });
        return { accepted: step !== refused };
      },
      upload: async (file, metadata, receivedSignal) => {
        calls.push('upload');
        assert.equal(file, artifact.outputPath);
        assert.deepEqual(metadata, {
          chunkKey,
          checksum: artifact.checksum,
          sizeInBytes: artifact.sizeInBytes,
        });
        assert.equal(receivedSignal, signal);
        return { accepted: refused !== 'upload' };
      },
    };
    const publish = () => publishClaimArtifact(context, artifact, 'rectangle-cut-pq-v1');
    if (refused) await assert.rejects(publish, /REFUSED|LEASE_LOST/);
    else assert.deepEqual(await publish(), { accepted: true });
    const steps = ['checkpoints', 'upload', 'validate', 'complete'];
    assert.deepEqual(
      calls,
      refused === 'lease' ? steps.slice(0, 3) : refused ? steps.slice(0, steps.indexOf(refused) + 1) : steps,
    );
  }
});

test(
  'native graph attempts discard output on lease loss or an exhausted output ceiling',
  {
    skip: process.env.STUDIO_HDR_GRAPH_NATIVE !== '1' && 'Requires explicit native hardware run',
  },
  async () => {
    for (const refused of ['lease', 'bytes']) {
      const claim = specimen();
      if (refused === 'bytes') claim.limits.maxOutputBytes = '1';
      let live = true;
      let beats = 0;
      const prepared = { ...claim, inputs: new Map() };
      const engineInputs = await createClaimImageInputs(prepared, () => live);
      const started = performance.now();
      let release;
      try {
        await assert.rejects(
          renderHdrGraph(
            {
              claim,
              prepared,
              engineInputs,
              heartbeat: async () => {
                if (refused === 'lease' && ++beats >= 2) live = false;
              },
              isLeaseActive: () => live,
              elapsedMs: () => performance.now() - started,
              registerRelease: (callback) => {
                release = callback;
              },
            },
            () => assert.fail('Refused attempt must not offer output to staging'),
          ),
          refused === 'lease' ? /LEASE_LOST/ : /OUTPUT_BYTE_LIMIT/,
        );
      } finally {
        live = false;
        await release?.();
        await engineInputs.dispose();
      }
    }
  },
);

test(
  'immutable authored HDR cut renders through the real float route to an independently decoded Main10 master',
  {
    skip:
      process.env.STUDIO_HDR_GRAPH_NATIVE !== '1' &&
      'Requires explicit native hardware run; does not manufacture worker admission',
  },
  async () => {
    const claim = specimen();
    const before = structuredClone(claim);
    const prepared = { ...claim, inputs: new Map() };
    let live = true;
    const engineInputs = await createClaimImageInputs(prepared, () => live);
    const require = createRequire(new URL('../engine/package.json', import.meta.url));
    const { tsImport } = require('tsx/esm/api');
    const { workingToSignal } = await tsImport(
      path.resolve('studio/engine/src/shared/graphics/color/managed-color.ts'),
      { parentURL: import.meta.url, tsconfig: false },
    );
    const started = performance.now();
    let release;
    let output;
    try {
      await renderHdrGraph(
        {
          claim,
          prepared,
          engineInputs,
          heartbeat: async () => {},
          isLeaseActive: () => live,
          elapsedMs: () => performance.now() - started,
          registerRelease: (callback) => {
            release = callback;
          },
        },
        async (artifact) => {
          output = artifact.outputPath;
          assert.deepEqual(
            [
              artifact.probe.codec,
              artifact.probe.profile,
              artifact.probe.pixFmt,
              artifact.probe.transfer,
              artifact.probe.primaries,
              artifact.probe.frames,
            ],
            ['hevc', 'Main 10', 'yuv420p10le', 'smpte2084', 'bt2020', 2],
          );
          const bytes = await readFile(output);
          assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.checksum);
          assert.ok(artifact.light.maxCll > 203, 'authored extended-range highlights survive');
          const expected = [
            [2.5, 1.2, 0.6],
            [0.2, 0.4, 0.6],
          ].map((rgb) => workingToSignal(rgb, 'pq', 203));
          const planes = decodeMaster('ffmpeg', output, 1280, 720, 'yuv420p10le');
          const oracle = validateHdrPlaneSamples(
            planes,
            1280,
            720,
            expected.map((rgb, frame) => ({ frame, x: 640, y: 360, rgb })),
          );
          // An independent authored-colour oracle, not copied from the rendered frames.
          assert.equal(oracle.length, 2);
          if (process.env.HDR_GRAPH_REPORT) {
            await writeFile(`${process.env.HDR_GRAPH_REPORT}.mp4`, bytes);
            await writeFile(
              process.env.HDR_GRAPH_REPORT,
              JSON.stringify(
                {
                  schemaVersion: 1,
                  qualification:
                    'bounded native graph output; no live admitted server or physical display certification',
                  claim,
                  ...artifact,
                  outputPath: `${process.env.HDR_GRAPH_REPORT}.mp4`,
                  signal: undefined,
                  authoredOracle: oracle,
                  expectedSignal: expected,
                },
                null,
                2,
              ),
            );
          }
        },
      );
      assert.deepEqual(claim, before, 'stored graph/settings were not migrated or rewritten');
      await assert.rejects(stat(output), /ENOENT/);
    } finally {
      live = false;
      await release?.();
      await engineInputs.dispose();
    }
  },
);
