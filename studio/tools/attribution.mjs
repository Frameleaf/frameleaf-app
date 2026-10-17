import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJsonRejectingDuplicateKeys } from '../../scripts/frameleaf-studio-contracts.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (file) => parseJsonRejectingDuplicateKeys(await readFile(file, 'utf8'), file);

// Never follow a link from a notice/package path into another checkout or outside the package.
async function regularFile(root, relative) {
  assert.ok(relative && !path.isAbsolute(relative) && relative.split('/').every((p) => p && p !== '.' && p !== '..'), `Unsafe attribution path: ${relative}`);
  let file = root;
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    assert.ok(!(await lstat(file)).isSymbolicLink(), `Linked attribution path: ${relative}`);
  }
  assert.ok((await lstat(file)).isFile(), `Not an attribution file: ${relative}`);
  return readFile(file);
}

async function expectedAttribution(studio, engine) {
  const manifestBytes = await regularFile(studio, 'dependency-attribution.json');
  const manifest = parseJsonRejectingDuplicateKeys(manifestBytes.toString(), 'dependency-attribution.json');
  assert.equal(manifest.rightsPolicy.distributionApproval, false, 'Rights approval is not established by this packager');
  const ids = new Set();
  for (const resource of manifest.resources) {
    assert.ok(resource.id && !ids.has(resource.id), `Invalid resource identity: ${resource.id}`);
    ids.add(resource.id);
    assert.ok(resource.basis && resource.locator && Array.isArray(resource.files), `Missing resource evidence: ${resource.id}`);
    // No resource has completed rights and runtime qualification in this slice.
    assert.deepEqual(resource.decisions, { redistribution: 'blocked', localRuntime: 'blocked', hostedUse: 'blocked' }, `Unreviewed resource approval: ${resource.id}`);
    for (const evidence of resource.evidence) {
      assert.equal(digest(await regularFile(studio, evidence.path)), evidence.sha256, `Resource evidence changed: ${resource.id}`);
    }
  }
  const notices = [];
  const payloads = new Map();
  for (const notice of manifest.artifactNotices) {
    assert.match(notice.id, /^[a-z0-9-]+$/);
    const bytes = await regularFile(studio, notice.path);
    assert.equal(digest(bytes), notice.sha256, `Source notice changed: ${notice.id}`);
    const file = `${notice.id}.txt`;
    assert.ok(!payloads.has(file), `Duplicate notice: ${notice.id}`);
    payloads.set(file, bytes);
    notices.push({ ...notice, file });
  }
  const packages = [];
  if (engine) {
    const lockBytes = await regularFile(engine, 'package-lock.json');
    assert.deepEqual(lockBytes, await regularFile(studio, 'engine-package-lock.json'), 'Generated lockfile differs from pinned package authority');
    const lock = parseJsonRejectingDuplicateKeys(lockBytes.toString(), 'package-lock.json');
    const packageEvidence = new Map();
    for (const binding of manifest.packageNoticeEvidence ?? []) {
      assert.ok(!packageEvidence.has(binding.location), `Duplicate package notice binding: ${binding.location}`);
      const pkg = lock.packages[binding.location];
      assert.ok(pkg && binding.location && pkg.dev !== true, `Unknown package notice binding: ${binding.location}`);
      for (const field of ['version', 'integrity', 'resolved']) {
        assert.ok(binding[field], `Missing package notice binding: ${binding.location}/${field}`);
        assert.equal(binding[field], pkg[field], `Package notice binding changed: ${binding.location}/${field}`);
      }
      assert.ok(Array.isArray(binding.noticeIds) && (binding.noticeIds.length || binding.unresolved), `Missing package notice decision: ${binding.location}`);
      assert.ok(binding.unresolved === null || (typeof binding.unresolved === 'string' && binding.unresolved.length), `Invalid package notice decision: ${binding.location}`);
      for (const id of binding.noticeIds) assert.ok(notices.some((notice) => notice.id === id), `Unknown package notice: ${id}`);
      assert.ok(Array.isArray(binding.evidence) && binding.evidence.length, `Missing package notice evidence: ${binding.location}`);
      for (const evidence of binding.evidence) {
        assert.ok(evidence.sourceUrl, `Missing package notice source: ${binding.location}`);
        assert.equal(digest(await regularFile(studio, evidence.path)), evidence.sha256, `Package notice evidence changed: ${binding.location}`);
      }
      packageEvidence.set(binding.location, binding);
    }
    for (const [location, pkg] of Object.entries(lock.packages).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (!location || pkg.dev === true) continue;
      const row = { location, version: pkg.version, declaredLicense: pkg.license ?? 'UNDECLARED', integrity: pkg.integrity ?? null, notices: [], status: 'missing-notice' };
      const directory = path.join(engine, location);
      const installed = await lstat(directory).catch((e) => { if (e.code === 'ENOENT' && pkg.optional) return null; throw e; });
      if (!installed) row.status = 'optional-not-installed';
      else {
        assert.ok(installed.isDirectory() && !installed.isSymbolicLink(), `Linked package: ${location}`);
        const actual = parseJsonRejectingDuplicateKeys((await regularFile(engine, `${location}/package.json`)).toString(), location);
        assert.equal(actual.version, pkg.version, `Package version changed: ${location}`);
        for (const name of (await readdir(directory)).sort()) {
          if (!/^(licen[cs]e|copying|notice|copyright)([.-]|$)/i.test(name)) continue;
          const bytes = await regularFile(engine, `${location}/${name}`);
          const file = `package-${digest(`${location}/${name}`).slice(0, 24)}.txt`;
          payloads.set(file, bytes);
          row.notices.push({ source: `${location}/${name}`, file, sha256: digest(bytes) });
        }
        const binding = packageEvidence.get(location);
        if (binding) {
          row.noticeEvidence = binding;
          for (const id of binding.noticeIds) {
            const notice = notices.find((notice) => notice.id === id);
            row.notices.push({ source: notice.path, file: notice.file, sha256: notice.sha256 });
          }
        }
        if (row.notices.length) row.status = 'notice-files-collected';
        if (binding?.unresolved) row.status = 'missing-notice';
      }
      packages.push(row);
    }
  }
  return { index: { schemaVersion: 1, engineRevision: manifest.engineRevision, manifestSha256: digest(manifestBytes), distributionApproval: false,
    qualification: 'Notices collected; embedded-code source obligations, rights and offline behavior remain unqualified.', notices, packages, resources: manifest.resources, rightsPolicy: manifest.rightsPolicy, embeddedComponents: manifest.embeddedComponents, dolbyTools: manifest.dolbyTools }, payloads };
}

export async function packageAttribution(studio, dist, engine) {
  const { index, payloads } = await expectedAttribution(studio, engine);
  const destination = path.join(dist, 'attribution');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination);
  for (const [file, bytes] of payloads) await writeFile(path.join(destination, file), bytes);
  await writeFile(path.join(destination, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return auditAttribution(studio, dist, engine);
}

// Recompute from trusted inputs; never repair or trust hashes supplied only by the output.
export async function auditAttribution(studio, dist, engine) {
  const { index, payloads } = await expectedAttribution(studio, engine);
  assert.deepEqual(await readJson(path.join(dist, 'attribution/index.json')), index, 'Artifact attribution inventory differs from trusted inputs');
  assert.deepEqual((await readdir(path.join(dist, 'attribution'))).sort(), [...payloads.keys(), 'index.json'].sort(), 'Unexpected or missing notice artifacts');
  for (const [file, bytes] of payloads) {
    assert.deepEqual(await regularFile(dist, `attribution/${file}`), bytes, `Artifact notice changed: ${file}`);
  }
  return { indexSha256: digest(await regularFile(dist, 'attribution/index.json')), noticeCount: payloads.size, resourceCount: index.resources.length,
    unresolvedPackages: index.packages.filter(({ status }) => status === 'missing-notice').map(({ location }) => location), distributionApproval: false };
}
