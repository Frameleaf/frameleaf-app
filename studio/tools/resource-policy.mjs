import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { parseJsonRejectingDuplicateKeys } from '../../scripts/frameleaf-studio-contracts.mjs';
import { approvalRowDigest, ownerApproval } from '../../scripts/frameleaf-studio-rights.mjs';

const readApproval = async (studio) => {
  try {
    return parseJsonRejectingDuplicateKeys(await readFile(path.join(studio, 'rights-approval.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

/**
 * The engine's runtime resource policy (FL-84/FL-86 follow-up): which resources the isolated
 * editor and headless engine may load in the browser, generated from the reviewed bill of
 * materials and the owner's approval, never maintained by hand.
 *
 * - A resource is admitted for local runtime only when the owner approved its exact reviewed row
 *   (`rights-approval.json`, bound to {@link approvalRowDigest}) for `localRuntime` and did not
 *   withhold that use. The admission carries that row digest, so a row that changes after
 *   approval is blocked again at the next prepare.
 * - The reviewed decisions in `dependency-attribution.json` stay as the packager recorded them;
 *   a manifest row that claims `allowed` itself is refused, so no JSON edit can admit anything.
 * - Everything else, including any id the manifest does not name, stays blocked.
 * - The pinned `locator` and `revision` travel with each entry, so a model fetched by URL is
 *   admitted only from the exact revision the owner approved (see `runtime/resource-admission.mjs`).
 *
 * `sha256` is reserved for a per-file byte digest; none is recorded yet, so byte verification
 * (`verifyResourceBytes`) still fails closed.
 */
export async function writeResourcePolicy(studio, engine) {
  const manifest = parseJsonRejectingDuplicateKeys(await readFile(path.join(studio, 'dependency-attribution.json'), 'utf8'));
  const approval = ownerApproval(await readApproval(studio), manifest);
  const policy = Object.create(null);
  for (const resource of manifest.resources) {
    assert.ok(resource.id && !Object.hasOwn(policy, resource.id), 'Duplicate resource policy identity');
    // Approval needs the owner's recorded decision, not a JSON edit of the reviewed row.
    assert.deepEqual(resource.decisions, { redistribution: 'blocked', localRuntime: 'blocked', hostedUse: 'blocked' }, `Unreviewed runtime approval: ${resource.id}`);
    const admitted = approval?.approved.get(resource.id) === true
      && approval.uses.includes('localRuntime')
      && !Object.hasOwn(approval.excluded.get(resource.id) ?? {}, 'localRuntime');
    policy[resource.id] = {
      localRuntime: admitted ? 'allowed' : 'blocked',
      approvalSha256: admitted ? approvalRowDigest(resource) : null,
      sha256: null,
      locator: typeof resource.locator === 'string' ? resource.locator : null,
      revision: typeof resource.revision === 'string' ? resource.revision : null,
    };
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
