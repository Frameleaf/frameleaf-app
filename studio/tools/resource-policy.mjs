import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { parseJsonRejectingDuplicateKeys } from '../../scripts/frameleaf-studio-contracts.mjs';

export async function writeResourcePolicy(studio, engine) {
  const manifest = parseJsonRejectingDuplicateKeys(await readFile(path.join(studio, 'dependency-attribution.json'), 'utf8'));
  const policy = Object.create(null);
  for (const resource of manifest.resources) {
    assert.ok(resource.id && !Object.hasOwn(policy, resource.id), 'Duplicate resource policy identity');
    // Approval needs a separate reviewed resolver implementation, not a JSON edit.
    assert.deepEqual(resource.decisions, { redistribution: 'blocked', localRuntime: 'blocked', hostedUse: 'blocked' }, `Unreviewed runtime approval: ${resource.id}`);
    policy[resource.id] = { localRuntime: 'blocked', sha256: null };
  }
  for (const relative of ['src/shared/utils', 'public/moss-tts']) {
    const destination = path.join(engine, relative);
    await mkdir(destination, { recursive: true });
    for (const name of ['resource-admission.mjs', 'resource-admission.d.mts']) {
      await cp(path.join(studio, 'runtime', name), path.join(destination, name));
    }
    await writeFile(path.join(destination, 'resource-policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
  }
}
