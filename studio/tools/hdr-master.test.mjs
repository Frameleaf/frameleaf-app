// FL-107: static metadata, refusals, encoder arguments and a real HEVC Main10
// round trip (skipped only when FFmpeg with libx265 is not installed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  decodeMaster, encodeHdrMaster, encoderArgs, masterDisplayParam, measureContentLight,
  pqDecode, probeMaster, toRgb48, validateHdrPlaneSamples, validateMastering,
} from './hdr-master.mjs';

const pqEncode = (nits) => {
  const m1 = 2610 / 16384; const m2 = (2523 / 4096) * 128;
  const c1 = 3424 / 4096; const c2 = (2413 / 4096) * 32; const c3 = (2392 / 4096) * 32;
  const y = Math.min(Math.max(nits / 10000, 0), 1) ** m1;
  return ((c1 + c2 * y) / (1 + c3 * y)) ** m2;
};
const frame = (width, height, texel) => {
  const rgba = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set(texel(i % width, Math.floor(i / width)), i * 4);
  return { width, height, rgba };
};

test('PQ decode matches ST 2084 reference points', () => {
  for (const nits of [0.1, 100, 203, 1000, 4000]) assert.ok(Math.abs(pqDecode(pqEncode(nits)) / nits - 1) < 1e-9);
});

test('content light levels come from the edited frames, per CTA-861.3', () => {
  const dim = frame(4, 2, () => [pqEncode(100), pqEncode(50), pqEncode(10), 1]);
  const bright = frame(4, 2, (x) => (x === 0 ? [pqEncode(400), pqEncode(900), 0, 1] : [pqEncode(203), 0, 0, 1]));
  const light = measureContentLight([dim, bright]);
  assert.equal(light.maxCll, 900);
  // Bright frame average: (900 + 3 * 203) / 4 per row = 377.25 → 378.
  assert.equal(light.maxFall, 378);
  // Transparent texels are black in the master.
  assert.deepEqual(measureContentLight([frame(2, 1, () => [1, 1, 1, 0])]), { maxCll: 0, maxFall: 0 });
});

test('mastering metadata is validated, never assumed', () => {
  assert.ok(validateMastering({ maxCll: 900, maxFall: 378 }, { maxNits: 1000, minNits: 0.005 }));
  assert.throws(() => validateMastering({ maxCll: 1200, maxFall: 300 }, { maxNits: 1000, minNits: 0.005 }),
    /above the 1000 cd\/m² mastering display/);
  assert.throws(() => validateMastering({ maxCll: 100, maxFall: 50 }, { maxNits: 0.001, minNits: 0.005 }),
    /range is invalid/);
  assert.equal(masterDisplayParam({ maxNits: 1000, minNits: 0.005 }),
    'G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,50)');
});

test('encoder arguments state the conversion and HDR signalling explicitly', () => {
  const pq = encoderArgs({ width: 64, height: 32, fps: 24, transfer: 'pq',
    light: { maxCll: 900, maxFall: 378 }, mastering: { maxNits: 1000, minNits: 0.005 }, output: 'o.mp4' }).join(' ');
  assert.match(pq, /-pix_fmt rgb48le/);
  assert.match(pq, /zscale=rangein=full:range=limited:matrixin=gbr:matrix=bt2020nc:dither=error_diffusion,format=yuv420p10le/);
  assert.match(pq, /profile=main10.*transfer=smpte2084.*hdr10=1.*max-cll=900,378/);
  assert.match(pq, /-color_trc smpte2084 -colorspace bt2020nc -color_range tv/);
  const hlg = encoderArgs({ width: 64, height: 32, fps: 24, transfer: 'hlg', light: null, mastering: null, output: 'o.mp4' }).join(' ');
  assert.match(hlg, /transfer=arib-std-b67/);
  assert.doesNotMatch(hlg, /max-cll|master-display/);
});

test('alpha is applied over black when packing rgb48', () => {
  const packed = new Uint16Array(toRgb48(frame(1, 1, () => [0.5, 1, 0, 0.5])).buffer.slice(0));
  assert.deepEqual(Array.from(packed), [16384, 32768, 0]);
});

test('native ten-bit luma/chroma QC uses independent BT.2020 codes and rejects bad evidence', () => {
  // Limited-range BT.2020 pure red: Y=294.1252, Cb=386.891..., Cr=960.
  const red = new Uint16Array([...Array(16).fill(294), ...Array(4).fill(387), ...Array(4).fill(960)]);
  const samples = [{ frame: 0, x: 2, y: 2, rgb: [1, 0, 0] }];
  const [result] = validateHdrPlaneSamples([red], 4, 4, samples);
  assert.deepEqual(result.actual, [294, 387, 960]);
  assert.ok(result.error.every((error) => error <= 2));
  const swapped = red.slice();
  swapped.set(red.subarray(20), 16); swapped.set(red.subarray(16, 20), 20);
  assert.throws(() => validateHdrPlaneSamples([swapped], 4, 4, samples), /plane error/);
  const wrongLuma = red.slice(); wrongLuma[10] += 3;
  assert.throws(() => validateHdrPlaneSamples([wrongLuma], 4, 4, samples), /plane error/);
  assert.throws(() => validateHdrPlaneSamples([red.subarray(1)], 4, 4, samples), /plane size/);
  assert.throws(() => validateHdrPlaneSamples([red], 4, 4, []), /sample/);
  assert.throws(() => validateHdrPlaneSamples([red], 4, 4, [{ ...samples[0], rgb: [NaN, 0, 0] }]), /signal/);
  assert.throws(() => validateHdrPlaneSamples([red], 4, 4, [{ ...samples[0], rgb: 'red' }]), /signal/);
  assert.throws(() => validateHdrPlaneSamples([red], 4, 4, [{ ...samples[0], x: 4 }]), /coordinate/);
});

const hasEncoder = (() => {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  return result.status === 0 && /libx265/.test(result.stdout) && spawnSync('ffprobe', ['-version']).status === 0;
})();

test('encoding and QC validation precede atomic publication', { skip: !hasEncoder }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fl-hdr-publish-'));
  try {
    const output = path.join(dir, 'master.mp4');
    const previous = Buffer.from('previous complete master');
    writeFileSync(output, previous);
    const invalidEncoder = path.join(dir, 'invalid-encoder.mjs');
    writeFileSync(invalidEncoder, '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nprocess.stdin.resume();\nprocess.stdin.on("end", () => writeFileSync(process.argv.at(-1), "invalid encoded output"));\n', { mode: 0o700 });
    const options = { frames: [frame(16, 16, () => [0.3, 0.3, 0.3, 1])], fps: 24,
      transfer: 'hlg', output, lossless: true };
    await assert.rejects(encodeHdrMaster({ ...options, ffmpeg: invalidEncoder }), /ffprobe/);
    assert.deepEqual(readFileSync(output), previous);
    await assert.rejects(encodeHdrMaster({ ...options, validate: ({ probe, decoded, output: partial }) => {
      assert.equal(probe.transfer, 'arib-std-b67');
      assert.equal(decoded.length, 1);
      assert.notEqual(partial, output);
      assert.deepEqual(readFileSync(output), previous);
      validateHdrPlaneSamples(decodeMaster('ffmpeg', partial, 16, 16, 'yuv420p10le'), 16, 16,
        [{ frame: 0, x: 8, y: 8, rgb: [1, 0, 0] }]);
    } }), /HDR plane error/);
    assert.deepEqual(readFileSync(output), previous);
    assert.ok(!readdirSync(dir).some((name) => name.endsWith('.partial.mp4')));
    await encodeHdrMaster(options);
    assert.notDeepEqual(readFileSync(output), previous);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HEVC Main10 HDR10 and HLG masters round-trip the signal', { skip: !hasEncoder && 'FFmpeg with libx265 unavailable' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fl-hdr-master-'));
  try {
    const width = 64;
    const height = 32;
    // Three edited frames: flat regions of 100 / 203 / 1000 cd/m² and a moving highlight.
    const frames = [0, 1, 2].map((n) => frame(width, height, (x, y) => {
      const nits = x < 16 ? 100 : x < 32 ? 203 : x < 48 ? 1000 : (y < 16 ? 600 + 100 * n : 50);
      const s = pqEncode(nits);
      return [s, s * (x < 48 ? 1 : 0.9), s * (y < 16 ? 1 : 0.8), 1];
    }));
    for (const transfer of ['pq', 'hlg']) {
      const output = path.join(dir, `${transfer}.mp4`);
      const signalFrames = transfer === 'pq' ? frames
        : frames.map((f) => ({ ...f, rgba: f.rgba.map((v, i) => (i % 4 === 3 ? v : Math.min(v * 1.1, 1))) }));
      const { light } = await encodeHdrMaster({ frames: signalFrames, fps: 24, transfer,
        mastering: { maxNits: 1000, minNits: 0.005 }, output, lossless: true });
      const probe = probeMaster('ffprobe', output);
      assert.equal(probe.codec, 'hevc');
      assert.equal(probe.profile, 'Main 10');
      assert.equal(probe.pixFmt, 'yuv420p10le');
      assert.equal(probe.primaries, 'bt2020');
      assert.equal(probe.matrix, 'bt2020nc');
      assert.equal(probe.range, 'tv');
      assert.equal(probe.transfer, transfer === 'pq' ? 'smpte2084' : 'arib-std-b67');
      assert.equal(probe.frames, 3);
      if (transfer === 'pq') {
        // Frame 2: (100 + 203 + 1000 + (800 + 50) / 2) / 4 = 432 cd/m² average.
        assert.deepEqual(light, { maxCll: 1000, maxFall: 432 });
        assert.equal(Number(probe.contentLight?.max_content), 1000);
        assert.equal(Number(probe.contentLight?.max_average), 432);
        assert.ok(probe.mastering, 'mastering display SEI present');
        assert.equal(probe.mastering.max_luminance, '10000000/10000');
      }
      // Independent decode of a lossless master: flat-region signal within the
      // 4:2:0 10-bit conversion (two codes per sample for RGB-YCbCr-RGB rounding, under one on average).
      const decoded = decodeMaster('ffmpeg', output, width, height);
      assert.equal(decoded.length, 3);
      const points = [[8, 8], [24, 24], [40, 8], [56, 4], [56, 28]];
      const planes = decodeMaster('ffmpeg', output, width, height, 'yuv420p10le');
      assert.equal(planes.length, 3);
      const planeSamples = validateHdrPlaneSamples(planes, width, height, signalFrames.flatMap(({ rgba }, frame) =>
        points.map(([x, y]) => ({ frame, x, y, rgb: rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 3) }))));
      assert.equal(planeSamples.length, 15);
      let errorSum = 0;
      let samples = 0;
      for (const [n, pixels] of decoded.entries()) {
        for (const [x, y] of points) {
          const i = (y * width + x);
          for (let c = 0; c < 3; c++) {
            const want = signalFrames[n].rgba[i * 4 + c];
            const error = Math.abs(pixels[i * 3 + c] - want);
            errorSum += error;
            samples++;
            assert.ok(error <= 2 / 1023, `${transfer} frame ${n} (${x},${y}) channel ${c}: ${pixels[i * 3 + c]} != ${want}`);
          }
        }
      }
      assert.ok(errorSum / samples <= 1 / 1023, `${transfer} mean signal error ${errorSum / samples}`);
    }
    // Refusal: content beyond the declared mastering display writes nothing.
    await assert.rejects(encodeHdrMaster({ frames, fps: 24, transfer: 'pq',
      mastering: { maxNits: 600, minNits: 0.005 }, output: path.join(dir, 'refused.mp4') }), /mastering display/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
