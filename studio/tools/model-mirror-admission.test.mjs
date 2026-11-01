// FL-685: a model served from the Frameleaf model mirror is admitted only at its approved
// revision and only with its pinned bytes. Synthetic policy; no download is made.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { writeResourcePolicy } from './resource-policy.mjs';
import { approvalRowDigest } from '../../scripts/frameleaf-studio-rights.mjs';

test('a mirror model is admitted only at its approved revision with its pinned bytes', async (t) => {
  const studio = path.resolve(import.meta.dirname, '..');
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-model-mirror-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = new TextEncoder().encode('synthetic vocabulary');
  const revision = 'b'.repeat(40);
  const locator = 'https://models.frameleaf.cloud/frameleaf/synthetic-asr';
  const row = { id: 'model:synthetic/asr', kind: 'model', locator, revision, licenseDeclared: 'Synthetic contract only',
    decisions: { redistribution: 'blocked', localRuntime: 'blocked', hostedUse: 'blocked' },
    files: [{ path: 'vocab.txt', sha256: createHash('sha256').update(payload).digest('hex') }] };
  await cp(path.join(studio, 'runtime'), path.join(root, 'runtime'), { recursive: true });
  await writeFile(path.join(root, 'dependency-attribution.json'), JSON.stringify({ schemaVersion: 1, resources: [row] }));
  await writeFile(path.join(root, 'rights-approval.json'), JSON.stringify({ schemaVersion: 1, approvedBy: 'Synthetic contract',
    approvedOn: '2026-10-31', source: 'Authored admission check, not production approval', uses: ['localRuntime'],
    resources: [{ id: row.id, sha256: approvalRowDigest(row) }] }));
  await writeResourcePolicy(root, path.join(root, 'engine'));
  const admission = await import(pathToFileURL(path.join(root, 'engine/src/shared/utils/resource-admission.mjs')));

  const pinned = `${locator}/resolve/${revision}/vocab.txt`;
  assert.equal(admission.requireResource(row.id).locator, locator);
  assert.equal(admission.approvedRevision(row.id), revision);
  assert.equal(admission.canUseResource(pinned), true);
  assert.deepEqual(await admission.verifyResourceBytes(pinned, payload), payload);
  await assert.rejects(admission.verifyResourceBytes(pinned, new TextEncoder().encode('tampered')), /FRAMELEAF_RESOURCE_BLOCKED/);
  for (const refused of [
    `${locator}/resolve/main/vocab.txt`,
    `${locator}/resolve/${'c'.repeat(40)}/vocab.txt`,
    `${locator}-lookalike/resolve/${revision}/vocab.txt`,
    `https://models.frameleaf.cloud/frameleaf/other/resolve/${revision}/vocab.txt`,
  ]) assert.equal(admission.canUseResource(refused), false, refused);
  await assert.rejects(admission.verifyResourceBytes(`${locator}/resolve/${revision}/unlisted.bin`, payload), /FRAMELEAF_RESOURCE_BLOCKED/);
});
