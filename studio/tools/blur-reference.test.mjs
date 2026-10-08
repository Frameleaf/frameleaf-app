import assert from 'node:assert/strict';
import test from 'node:test';
import { blurReference } from './blur-reference.mjs';

test('independent blur oracle ignores hidden light and retains coverage and identity', () => {
  const input = [8, 2, -1, 1, 65504, 65504, 65504, 0];
  assert.deepEqual(blurReference(input, 2, 1, 'gpu-box-blur', { radius: 1 }),
    [8, 2, -1, 2 / 3, 8, 2, -1, 1 / 3]);
  assert.deepEqual(blurReference(input, 2, 1, 'gpu-box-blur', { radius: 0 }), input);
  assert.deepEqual(blurReference(input, 2, 1, 'gpu-motion-blur',
    { amount: 0.001, angle: 0, samples: 16, shutterAngle: 180 }), input);
  assert.deepEqual(blurReference([8, 8, 8, 0], 1, 1, 'gpu-box-blur', { radius: 1 }), [0, 0, 0, 0]);
});
