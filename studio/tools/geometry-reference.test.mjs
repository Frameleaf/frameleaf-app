import assert from 'node:assert/strict';
import test from 'node:test';
import { geometryReference } from './geometry-reference.mjs';

test('Geometry excludes hidden RGB and preserves signed straight light after interpolation', () => {
  const values = [8,-.25,2,1,32,4,-2,0,8,-.25,2,1,32,4,-2,0];
  const actual = geometryReference(values,2,2,'gpu-wave',{amplitudeX:0,amplitudeY:.1,frequencyX:1,frequencyY:1});
  assert.deepEqual(actual.slice(0,3),[8,-.25,2]);
  assert.equal(actual[3],new Float16Array([.8])[0]);
  assert.deepEqual(actual.slice(4,8),[0,0,0,0]);
});

test('Coverage rounded to zero in binary16 clears RGB before the next pass', () => {
  const tiny = 2 ** -24;
  const values = [32,4,-2,0,8,-.25,2,tiny,32,4,-2,0,32,4,-2,0];
  const actual = geometryReference(values,2,2,'gpu-wave',{amplitudeX:0,amplitudeY:.1,frequencyX:1,frequencyY:1});
  assert.deepEqual(actual.slice(0,4),[0,0,0,0]);
  assert.deepEqual(actual.slice(4,8),[8,-.25,2,tiny]);
});
