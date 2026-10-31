import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { validateHardwareReadback } from './render-worker-probe.mjs';

// Contract fixtures only; these tests are not hardware evidence.
const specimen = () => ({
  adapter: { vendor: 'test-device', description: 'contract fixture', isFallbackAdapter: false },
  format: 'rgba16float', pixels: [-0.5, 2, 0.25, 0.5, -0.5, 2, 0.25, 0.5],
});

test('refuses missing, fallback and known software adapter evidence', () => {
  for (const isFallbackAdapter of [undefined, null, true]) {
    const result = specimen();
    result.adapter.isFallbackAdapter = isFallbackAdapter;
    assert.throws(() => validateHardwareReadback(result), /SOFTWARE_RENDERER_OR_UNKNOWN/);
  }
  const hidden = specimen();
  hidden.adapter = { isFallbackAdapter: false };
  assert.throws(() => validateHardwareReadback(hidden), /ADAPTER_IDENTITY_UNAVAILABLE/);
  for (const description of ['SwiftShader Device', 'llvmpipe', 'lavapipe', 'Microsoft Basic Render Driver']) {
    const result = specimen();
    result.adapter.description = description;
    assert.throws(() => validateHardwareReadback(result), /SOFTWARE_RENDERER/);
  }
});

test('requires signed extended-range colour and fractional alpha in the real readback', () => {
  validateHardwareReadback(specimen());
  for (const [channel, value] of [[0, 0], [1, 1], [3, 1], [4, NaN], [5, Infinity]]) {
    const result = specimen();
    result.pixels[channel] = value;
    assert.throws(() => validateHardwareReadback(result), /COMPOSITOR_READBACK_MISMATCH/);
  }
});

test('real SwiftShader execution cannot emit a successful hardware report', {
  skip: process.env.STUDIO_WORKER_PROBE_BROWSER_TEST !== '1', timeout: 90_000,
}, async () => {
  try {
    await promisify(execFile)(process.execPath, ['studio/tools/render-worker-probe.mjs'], {
      timeout: 75_000,
      env: { ...process.env,
        FREECUT_CHROME_ARGS_REPLACE: '--enable-unsafe-webgpu --use-angle=swiftshader --use-vulkan=swiftshader --enable-features=Vulkan',
      },
    });
    assert.fail('Software renderer must not qualify');
  } catch (error) {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /SOFTWARE_RENDERER/);
    assert.equal(error.stdout, '', 'A refused probe must not write successful evidence');
  }
});
