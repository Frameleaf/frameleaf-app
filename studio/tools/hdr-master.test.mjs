// FL-107: static metadata, refusals, encoder arguments and a real HEVC Main10
// round trip (skipped only when FFmpeg with libx265 is not installed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  TEN_BIT_QUANTISER, decodeMaster, encodeHdrMaster, encoderArgs, inverseRgb, masterDisplayParam, measureContentLight,
  pqDecode, probeMaster, rawFrameBytes, toRgb48, validateHdrPlaneSamples, validateMastering,
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
  assert.match(pq, /zscale=rangein=full:range=limited:matrixin=gbr:matrix=bt2020nc:dither=none,format=yuv420p10le/);
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

test('decoded frame sizes count two bytes per ten-bit sample', () => {
  assert.equal(rawFrameBytes(1024, 128, 'yuv420p10le'), 393216);
  assert.equal(rawFrameBytes(1024, 128, 'rgb48le'), 786432);
  assert.throws(() => rawFrameBytes(1023, 128, 'yuv420p10le'), /even dimensions/);
  assert.throws(() => rawFrameBytes(16, 16, 'yuv420p'), /Unsupported/);
});

test('inverse BT.2020 NCL matrix inverts the limited-range codes', () => {
  assert.deepEqual(inverseRgb([64, 512, 512]), [0, 0, 0]);
  inverseRgb([940, 512, 512]).forEach((value) => assert.ok(Math.abs(value - 1) < 1e-12));
  // Pure red codes reconstruct within the two-code limit; an off-by-three Cb does not.
  inverseRgb([294, 387, 960]).forEach((value, c) => assert.ok(Math.abs(value - [1, 0, 0][c]) * 1023 < 0.2));
  assert.ok(Math.abs(inverseRgb([294, 390, 960])[2]) * 1023 > 2);
});

const hasEncoder = (() => {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  return result.status === 0 && /libx265/.test(result.stdout) && spawnSync('ffprobe', ['-version']).status === 0;
})();

test('two-frame 4K masters preserve presentation order and independent picture values', { skip: !hasEncoder }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fl-hdr-short-4k-'));
  const width = 3840;
  const height = 2160;
  const values = [pqEncode(100), pqEncode(900)];
  try {
    const frames = values.map((value) => frame(width, height, () => [value, value, value, 1]));
    const output = path.join(dir, 'master.mp4');
    await encodeHdrMaster({ frames, fps: 24, transfer: 'pq', output, lossless: true,
      mastering: { maxNits: 1000, minNits: 0.005 }, validate: ({ probe, decoded, output: partial }) => {
        assert.equal(probe.frames, 2);
        assert.equal(probe.rFrameRate, '24/1');
        const timestamps = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
          '-show_entries', 'frame=pts_time', '-of', 'json', partial], { encoding: 'utf8' });
        assert.equal(timestamps.status, 0, timestamps.stderr);
        assert.deepEqual(JSON.parse(timestamps.stdout).frames.map((value) => value.pts_time), ['0.000000', '0.041667']);
        decoded.forEach((pixels, index) => {
          for (const [x, y] of [[0, 0], [width / 2, height / 2], [width - 1, height - 1]]) {
            for (let channel = 0; channel < 3; channel++)
              assert.ok(Math.abs(pixels[(y * width + x) * 3 + channel] - values[index]) <= 2 / 1023);
          }
        });
      } });
    assert.ok(!readdirSync(dir).some((name) => name.endsWith('.partial.mp4')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

// Sixteen flat patches over two gradient rows, the shape of the 1024x128 retained
// diagnostic whose error-diffused master measured 2.92 RGB10 codes (blue, patch 13).
const patchColour = (p) => [0, 1, 2].map((c) => 0.08 + 0.84 * (((p * 7 + c * 5 + 3) * 0.6180339887) % 1));
const patchFrame = (width, height, scale = 1) => frame(width, height, (x, y) => y < height / 2
  ? [...patchColour(Math.floor(x / (width / 16))).map((v) => Math.min(v * scale, 1)), 1]
  : [x / width, 1 - x / width, (y - height / 2) / (height / 2), 1]);
const patchInteriors = (width, height) => {
  const side = width / 16;
  const points = [];
  for (let p = 0; p < 16; p++) for (let y = 8; y < height / 2 - 8; y++)
    for (let x = p * side + 8; x < (p + 1) * side - 8; x++) points.push([x, y]);
  return points;
};

test('error diffusion breaks the inverse-RGB limit that rounding meets (fixture discriminates)', { skip: !hasEncoder }, () => {
  const width = 1024; const height = 128;
  const { rgba } = patchFrame(width, height);
  const maxError = (dither) => {
    const result = spawnSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-s', `${width}x${height}`, '-i', '-',
      '-vf', `format=gbrp16le,zscale=rangein=full:range=limited:matrixin=gbr:matrix=bt2020nc:dither=${dither},format=yuv420p10le`,
      '-frames:v', '1', '-f', 'rawvideo', '-'], { input: toRgb48({ width, height, rgba }), maxBuffer: 1 << 24 });
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(result.stdout.byteLength, rawFrameBytes(width, height, 'yuv420p10le'));
    const planes = new Uint16Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength / 2);
    const pixels = width * height;
    let max = 0;
    for (const [x, y] of patchInteriors(width, height)) {
      const chroma = (y >> 1) * (width / 2) + (x >> 1);
      inverseRgb([planes[y * width + x], planes[pixels + chroma], planes[pixels * 1.25 + chroma]]).forEach((value, c) => {
        max = Math.max(max, Math.abs(value - rgba[(y * width + x) * 4 + c]) * 1023);
      });
    }
    return max;
  };
  assert.ok(maxError('error_diffusion') > 2, 'fixture must expose error-diffused drift');
  assert.ok(maxError(TEN_BIT_QUANTISER) <= 1.66, 'rounded codes stay inside the analytical 1.66-code bound');
});

test('HDR10 and HLG masters meet the inverse-RGB limit on every flat-patch pixel', { skip: !hasEncoder }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fl-hdr-inverse-rgb-'));
  const width = 1024; const height = 128;
  try {
    for (const transfer of ['pq', 'hlg']) {
      const frames = [patchFrame(width, height, transfer === 'pq' ? 1 : 0.95)];
      const output = path.join(dir, `${transfer}.mp4`);
      let worst = 0;
      await encodeHdrMaster({ frames, fps: 24, transfer, output, lossless: true,
        mastering: { maxNits: 10000, minNits: 0.005 }, validate: ({ output: partial }) => {
          const planes = decodeMaster('ffmpeg', partial, width, height, 'yuv420p10le');
          const samples = patchInteriors(width, height).map(([x, y]) => ({ frame: 0, x, y,
            rgb: frames[0].rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 3) }));
          for (const { rgbError } of validateHdrPlaneSamples(planes, width, height, samples))
            worst = Math.max(worst, ...rgbError);
        } });
      assert.ok(worst > 0 && worst <= 1.66, `${transfer} worst inverse-RGB error ${worst}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
