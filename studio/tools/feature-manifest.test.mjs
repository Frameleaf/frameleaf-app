import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { checkFrameleafStatus } from './feature-manifest.mjs';

const read = async (name) => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8'));

test('every row records a Frameleaf delivery status, and shipped rows cite evidence (FL-405)', async () => {
  const manifest = await read('freecut-feature-manifest.json');
  const patches = new Set((await read('engine-build.json')).patches.map(({ path }) => path.replace('patches/', '')));
  checkFrameleafStatus(manifest, patches);

  const row = (frameleaf) => ({ features: [{ id: 'x', frameleaf }] });
  assert.throws(() => checkFrameleafStatus(row(undefined), patches), /frameleaf\.status/);
  assert.throws(() => checkFrameleafStatus(row({ status: 'done', evidence: [] }), patches), /frameleaf\.status/);
  assert.throws(() => checkFrameleafStatus(row({ status: 'shipped', evidence: [] }), patches), /needs evidence/);
  assert.throws(() => checkFrameleafStatus(row({ status: 'shipped', evidence: ['9999-missing.patch'] }), patches), /engine-build/);
  checkFrameleafStatus(row({ status: 'not-started', evidence: [] }), patches);
});
