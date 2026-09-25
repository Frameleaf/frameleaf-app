import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ATTRIBUTION_PATH,
  SERVER_MIRROR_PATH,
  buildServerMirror,
  generate,
  rightsRows,
} from './frameleaf-studio-rights.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFile(path.join(repository, file), 'utf8');

test('the server rights mirror matches the reviewed bill of materials', async () => {
  const files = await generate(repository);
  assert.equal(await read(SERVER_MIRROR_PATH), files[SERVER_MIRROR_PATH]);
});

test('every reviewed resource stays blocked until the owner approves it (FL-146 default)', async () => {
  const manifest = JSON.parse(await read(ATTRIBUTION_PATH));
  const { distributionApproval, rows } = rightsRows(manifest);
  assert.equal(distributionApproval, false);
  assert.equal(rows.length, manifest.resources.length);
  for (const row of rows) {
    assert.deepEqual([row.redistribution, row.localRuntime, row.hostedUse], ['blocked', 'blocked', 'blocked'], row.id);
  }
  // The rows the acceptance names explicitly are present rather than silently dropped.
  const ids = new Set(rows.map((row) => row.id));
  for (const id of ['model:Xenova/musicgen-small', 'asset:lottiefiles', 'tool:dolby-portal', 'tool:dolby-artistic-trim']) {
    assert.ok(ids.has(id), id);
  }
  assert.ok(rows.some((row) => row.kind === 'voice'));
  assert.ok(rows.some((row) => row.kind === 'font'));
  assert.ok(rows.some((row) => row.kind === 'bundled-weights'));
});

const minimal = (resources, policy = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    rightsPolicy: { distributionApproval: false, unknownResource: 'blocked', ...policy },
    resources,
  });
const row = (id, decisions = { redistribution: 'blocked', localRuntime: 'blocked', hostedUse: 'blocked' }) => ({
  id,
  kind: id.split(':')[0],
  decisions,
});

test('an unreviewed or malformed row fails generation instead of disappearing', () => {
  assert.throws(() => buildServerMirror(minimal([row('font:A', { redistribution: 'blocked' })])), /no reviewed localRuntime/);
  assert.throws(
    () => buildServerMirror(minimal([row('font:A', { redistribution: 'maybe', localRuntime: 'blocked', hostedUse: 'blocked' })])),
    /no reviewed redistribution/,
  );
  assert.throws(() => buildServerMirror(minimal([row('font:A'), row('font:A')])), /duplicate resource font:A/);
  assert.throws(() => buildServerMirror(minimal([row('Roboto')])), /must be "<kind>:<name>"/);
  assert.throws(() => buildServerMirror(minimal([row('font:A')], { unknownResource: 'allowed' })), /must stay "blocked"/);
  assert.throws(() => buildServerMirror(minimal([])), /non-empty/);
});

test('an approved use is carried through exactly as reviewed', () => {
  const text = buildServerMirror(
    minimal([row('font:It\'s', { redistribution: 'blocked', localRuntime: 'allowed', hostedUse: 'blocked' })]),
  );
  assert.match(text, /'font:It\\'s': \{\n {4}kind: 'font',\n {4}license: null,\n {4}redistribution: 'blocked',\n {4}localRuntime: 'allowed',/);
  assert.match(text, /STUDIO_DISTRIBUTION_APPROVAL = false;/);
});
