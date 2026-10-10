import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { muxEmbeddedSubtitles } from './render-worker-embedded-subtitles.mjs';

const require = createRequire(import.meta.url);
const { sealStudioEmbeddedSubtitles } = require('../../server/dist/utils/studio-embedded-subtitles.js');
const { buildStudioSidecarSemanticPlan } = require('../../server/dist/utils/studio-subtitle-sidecar.js');
const graph = {
  metadata: { fps: 24 },
  timeline: {
    tracks: [{ id: 'c', visible: true }],
    items: [
      {
        id: 'c',
        trackId: 'c',
        type: 'subtitle',
        source: { type: 'subtitle-import' },
        from: 0,
        durationInFrames: 24,
        cues: [{ startSeconds: 0, endSeconds: 0.5, text: 'Caption' }],
      },
    ],
    transitions: [],
    keyframes: [],
  },
};
const seal = sealStudioEmbeddedSubtitles(graph, {
  revisionDigest: 'a'.repeat(64),
  manifestDigest: 'b'.repeat(64),
  engineDigest: 'c'.repeat(64),
});
const content = buildStudioSidecarSemanticPlan(graph).content;

test('mux refuses changed bytes, invalid codec/disposition, cancellation and lost lease before spawning or replacing media', async () => {
  for (const failure of ['hash', 'codec', 'disposition', 'abort', 'lease-before-write', 'lease-after-write']) {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'fl105-mux-control-'));
    const input = path.join(folder, 'media.mp4');
    // Deliberately not a media acceptance fixture: every control must refuse before any encoder executes.
    const bytes = Buffer.from('unit control: must never reach ffmpeg');
    await writeFile(input, bytes);
    let checks = 0;
    try {
      await assert.rejects(
        muxEmbeddedSubtitles({
          input,
          folder,
          content: failure === 'hash' ? content + 'changed' : content,
          seal:
            failure === 'codec'
              ? { ...seal, codec: 'webvtt' }
              : failure === 'disposition'
                ? { ...seal, default: 0 }
                : seal,
          maxBytes: 1024,
          maxMs: 1000,
          signal: failure === 'abort' ? AbortSignal.abort(new Error('CANCELLED_CONTROL')) : undefined,
          assertLive: async () => {
            checks++;
            if ((failure === 'lease-before-write' && checks === 1) || (failure === 'lease-after-write' && checks === 2))
              throw new Error('LEASE_LOST_CONTROL');
          },
          ffmpeg: '/must-never-spawn-fl105-control',
        }),
      );
      assert.deepEqual(await readFile(input), bytes);
      assert.deepEqual(await readdir(folder), ['media.mp4']);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
});
