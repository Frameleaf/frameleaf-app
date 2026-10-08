import assert from 'node:assert/strict';
import test from 'node:test';
import { blurReference } from './blur-reference.mjs';

test('independent blur oracle ignores hidden light and retains coverage and identity', () => {
  const input = [8, 2, -1, 1, 65504, 65504, 65504, 0];
  assert.deepEqual(blurReference(input, 2, 1, 'gpu-box-blur', { radius: 1 }),
    [8, 2, -1, Number(new Float16Array([2/3])[0]), 8, 2, -1, Number(new Float16Array([1/3])[0])]);
  assert.deepEqual(blurReference(input, 2, 1, 'gpu-box-blur', { radius: 0 }), input);
  assert.deepEqual(blurReference(input, 2, 1, 'gpu-motion-blur',
    { amount: 0.001, angle: 0, samples: 16, shutterAngle: 180 }), input);
  assert.deepEqual(blurReference([8, 8, 8, 0], 1, 1, 'gpu-box-blur', { radius: 1 }), [0, 0, 0, 0]);
});

for (const [type, params] of [
  ['gpu-box-blur', {radius:1}],
  ['gpu-gaussian-blur', {radius:1,samples:5}],
  ['gpu-motion-blur', {amount:.1,angle:0,samples:16,shutterAngle:360}],
]) {
  test(`${type} final storage rounds half coverage, clears underflow RGB, and retains signed/headroom light`, () => {
    // Power-of-two coverage survives the unchanged weighted accumulation exactly.
    // Positive odd/even midpoint tests use box/gaussian; arbitrary motion
    // weights can put the accumulated alpha on either side of an input tie.
    const alphas=[0,2**-26,2**-25,2**-24,2**-14,.25,.5,1];
    if(type!=='gpu-motion-blur')alphas.push(3*2**-25,5*2**-25);
    for (const alpha of alphas) {
      const expected = Number(new Float16Array([alpha])[0]);
      const output = blurReference([8,-.25,2,alpha],1,1,type,params);
      assert.deepEqual(output, expected === 0 ? [0,0,0,0] : [8,-.25,2,expected]);
    }
  });
}
