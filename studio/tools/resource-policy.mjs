import { copySubtitleSidecarRuntime } from './owned-subtitle-runtime.mjs';
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

// Paths are literal repository-relative identities, never a URL, query, or encoded alias.
// Existing bundled npm files are validated too, but do not become network identities.
function fileBindings(resource, admitted) {
  assert.ok(Array.isArray(resource.files), `Missing resource file inventory: ${resource.id}`);
  const files = Object.create(null);
  const seen = new Set();
  for (const file of resource.files) {
    assert.ok(file && typeof file === 'object' && !Array.isArray(file)
      && Object.keys(file).length === 2 && Object.hasOwn(file, 'path') && Object.hasOwn(file, 'sha256'), `Invalid resource file schema: ${resource.id}`);
    assert.ok(typeof file.path === 'string' && /^[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/.test(file.path)
      && !file.path.split('/').some((part) => part === '.' || part === '..'), `Invalid resource file path: ${resource.id}`);
    assert.ok(!seen.has(file.path), `Duplicate resource file: ${resource.id}`);
    seen.add(file.path);
    assert.ok(file.sha256 === null || /^[a-f0-9]{64}$/.test(file.sha256 ?? ''), `Invalid resource file hash: ${resource.id}`);
    if (!admitted || file.sha256 === null || !/^[a-f0-9]{40}$/.test(resource.revision ?? '')) continue;
    let url;
    if (/^(?:spaces\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(resource.locator ?? '')) {
      const segments = resource.locator.split('/');
      assert.ok(!segments.some((part) => part === '.' || part === '..'), `Invalid repository locator: ${resource.id}`);
      url = `https://huggingface.co/${resource.locator}/resolve/${resource.revision}/${file.path}`;
    } else if (typeof resource.locator === 'string' && resource.locator.startsWith('https://')) {
      // A reviewed full-file locator binds only itself. No directory-prefix guessing.
      const locator = new URL(resource.locator);
      if (locator.origin !== 'https://huggingface.co' || locator.href !== resource.locator
        || locator.username || locator.password || locator.search || locator.hash || locator.pathname.includes('%')
        || !locator.pathname.includes(`/resolve/${resource.revision}/`) || !locator.pathname.endsWith(`/${file.path}`)) continue;
      url = locator.href;
    }
    if (!url) continue;
    assert.ok(!Object.hasOwn(files, url), `Duplicate resource file URL: ${resource.id}`);
    files[url] = { url, path: file.path, sha256: file.sha256, revision: resource.revision, approvalSha256: approvalRowDigest(resource) };
  }
  return files;
}

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
 * Root `sha256` stays null. Per-file digests are emitted only for exact URLs in an owner-approved
 * row; absent/null hashes never admit bytes. This does not activate any loader transport.
 */
export async function writeResourcePolicy(studio, engine) {
  const manifest = parseJsonRejectingDuplicateKeys(await readFile(path.join(studio, 'dependency-attribution.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1, 'Unsupported resource manifest schema');
  assert.ok(Array.isArray(manifest.resources) && manifest.resources.length, 'Missing resource rows');
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
      files: fileBindings(resource, admitted),
      locator: typeof resource.locator === 'string' ? resource.locator : null,
      revision: typeof resource.revision === 'string' ? resource.revision : null,
    };
  }
  await copySubtitleSidecarRuntime(studio, path.join(engine, 'src/shared/utils'), engine);
  for (const relative of ['src/shared/utils', 'public/moss-tts']) {
    const destination = path.join(engine, relative);
    await mkdir(destination, { recursive: true });
    for (const name of ['resource-admission.mjs', 'resource-admission.d.mts']) {
      await cp(path.join(studio, 'runtime', name), path.join(destination, name));
    }
    await writeFile(path.join(destination, 'resource-policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
  }
}
