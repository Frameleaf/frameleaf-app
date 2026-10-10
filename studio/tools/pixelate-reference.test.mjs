import assert from 'node:assert/strict';
import test from 'node:test';
import { pixelateReference } from './pixelate-reference.mjs';

test('Pixelate retains signed light, excludes hidden RGB and clamps edge taps', () => {
  const input = [8, -.25, 2, 1, 32, 4, -2, 0];
  assert.deepEqual(pixelateReference(input, 2, 1, { size: 1 }), [8, -.25, 2, 1, 0, 0, 0, 0]);
  assert.deepEqual(pixelateReference(input, 2, 1, { size: 2 }), [8, -.25, 2, .5, 8, -.25, 2, .5]);
  assert.deepEqual(pixelateReference(input, 2, 1, { size: 64 }), [0, 0, 0, 0, 0, 0, 0, 0]);
});
