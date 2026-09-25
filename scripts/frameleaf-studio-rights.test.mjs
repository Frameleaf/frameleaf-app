import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APPROVAL_PATH,
  ATTRIBUTION_PATH,
  SERVER_MIRROR_PATH,
  approvalRowDigest,
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

test('the packager review keeps its decisions; the owner approval is recorded beside it (FL-146)', async () => {
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

test('the owner approved every one of the 210 reviewed resources on 2026-09-25, each bound to its row', async () => {
  const manifest = JSON.parse(await read(ATTRIBUTION_PATH));
  const approval = JSON.parse(await read(APPROVAL_PATH));
  assert.equal(approval.approvedOn, '2026-09-25');
  assert.match(approval.source, /FL-146/);
  assert.equal(approval.resources.length, 210);
  const byId = new Map(manifest.resources.map((resource) => [resource.id, resource]));
  for (const entry of approval.resources) {
    assert.equal(entry.sha256, approvalRowDigest(byId.get(entry.id)), entry.id);
  }
  const mirror = await read(SERVER_MIRROR_PATH);
  assert.equal((mirror.match(/localRuntime: 'allowed'/g) ?? []).length, 210);
  assert.equal((mirror.match(/approvedOn: '2026-09-25'/g) ?? []).length, 211);
  assert.match(mirror, /STUDIO_DISTRIBUTION_APPROVAL = false;/);
});

test('an approval covers only the exact row it was given; new, changed and unknown rows stay blocked', () => {
  const resources = [row('font:A'), row('font:B'), row('font:C')];
  const approval = (entries) =>
    JSON.stringify({
      schemaVersion: 1,
      approvedBy: 'Owner',
      approvedOn: '2026-09-25',
      source: 'FL-146',
      uses: ['redistribution', 'localRuntime', 'hostedUse'],
      resources: entries,
    });
  const text = buildServerMirror(
    minimal(resources),
    approval([
      { id: 'font:A', sha256: approvalRowDigest(resources[0]) },
      // font:B changed after it was approved.
      { id: 'font:B', sha256: '0'.repeat(64) },
    ]),
  );
  assert.match(text, /'font:A': \{[^}]*localRuntime: 'allowed',[^}]*approvedOn: '2026-09-25'/s);
  assert.match(text, /'font:B': \{[^}]*localRuntime: 'blocked',[^}]*approvedOn: null/s);
  assert.match(text, /'font:C': \{[^}]*localRuntime: 'blocked',[^}]*approvedOn: null/s);
  assert.throws(
    () => buildServerMirror(minimal(resources), approval([{ id: 'font:Z', sha256: 'x' }])),
    /font:Z is not a reviewed resource/,
  );
  assert.throws(
    () => buildServerMirror(minimal(resources), approval([]).replace('2026-09-25', 'yesterday')),
    /approvedOn must be a date/,
  );
});
