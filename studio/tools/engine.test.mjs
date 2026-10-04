import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { admitAdaptedSource, inventory, licenses, sourceRecoveryContext, verifySnapshot } from './engine.mjs';
import { assertPinnedSource } from '../../scripts/frameleaf-studio-contracts.mjs';
import { writeResourcePolicy } from './resource-policy.mjs';
import { approvalRowDigest, ownerApproval } from '../../scripts/frameleaf-studio-rights.mjs';

test('engine source pin rejects a changed archive without local planning files', async () => {
  const provenance = JSON.parse(await readFile(new URL('../freecut-provenance.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => assertPinnedSource(provenance));
  provenance.archiveSha256 = '0'.repeat(64);
  assert.throws(() => assertPinnedSource(provenance));
});

test('snapshot gate rejects mutations, extra files, missing files and symlinks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-snapshot-'));
  try {
    await mkdir(path.join(directory, 'headless'));
    await writeFile(path.join(directory, 'headless.html'), 'entry');
    await writeFile(path.join(directory, 'headless/contract.mjs'), 'contract');
    const files = await inventory(directory);
    assert.deepEqual(files.map(({ path }) => path), ['headless.html', 'headless/contract.mjs']);
    await verifySnapshot(directory, files);
    await writeFile(path.join(directory, 'headless.html'), 'tampered');
    await assert.rejects(verifySnapshot(directory, files));
    await writeFile(path.join(directory, 'headless.html'), 'entry');
    await writeFile(path.join(directory, 'extra'), 'generated');
    await assert.rejects(verifySnapshot(directory, files));
    await rm(path.join(directory, 'extra'));
    await rm(path.join(directory, 'headless.html'));
    await assert.rejects(verifySnapshot(directory, files));
    await symlink(path.join(directory, 'headless/contract.mjs'), path.join(directory, 'headless.html'));
    await assert.rejects(verifySnapshot(directory, files), /Not a regular file/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('license inventory retains every lockfile dependency, including transitive, optional and unknown declarations', async () => {
  const lock = JSON.parse(await readFile(new URL('../engine-package-lock.json', import.meta.url), 'utf8'));
  const rows = licenses(lock);
  assert.equal(rows.length, Object.keys(lock.packages).length - 1);
  assert.ok(rows.some(({ location }) => location.split('node_modules/').length > 2));
  assert.ok(rows.some(({ optional }) => optional));
  assert.equal(licenses({ packages: { '': {}, 'node_modules/example': { version: '1.0.0' } } })[0].license, 'UNDECLARED');
  assert.equal(lock.name, '@frameleaf/studio-engine');
});

test('artifact notices are distributed and independently audited against trusted source bytes', async () => {
  const { packageAttribution, auditAttribution } = await import('./attribution.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-attribution-'));
  try {
    const studio = path.resolve(import.meta.dirname, '..');
    const dist = path.join(directory, 'dist');
    await mkdir(dist);
    await packageAttribution(studio, dist);
    await auditAttribution(studio, dist);
    const bundled = JSON.parse(await readFile(path.join(dist, 'attribution/index.json'), 'utf8'));
    assert.ok(bundled.notices.some(({ id }) => id === 'mediabunny-mpl'));
    assert.ok(bundled.notices.some(({ id }) => id === 'soundtouch'));
    assert.equal(bundled.distributionApproval, false);
    const notice = path.join(dist, 'attribution', bundled.notices[0].file);
    await writeFile(notice, 'altered license');
    await assert.rejects(auditAttribution(studio, dist), /notice/i);
    await rm(notice);
    await assert.rejects(auditAttribution(studio, dist), /ENOENT|notice/i);
    await packageAttribution(studio, dist);
    bundled.resources.push({ id: 'model:unknown-provider/unknown-weights' });
    await writeFile(path.join(dist, 'attribution/index.json'), JSON.stringify(bundled));
    await assert.rejects(auditAttribution(studio, dist), /inventory/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('artifact audit includes installed runtime package notices and rejects package/version or output substitution', async () => {
  const { packageAttribution, auditAttribution } = await import('./attribution.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-package-notices-'));
  const sourceStudio = path.resolve(import.meta.dirname, '..');
  const studio = path.join(directory, 'studio');
  try {
    await mkdir(studio);
    for (const name of ['dependency-attribution.json', 'notices', 'rights-evidence']) {
      await cp(path.join(sourceStudio, name), path.join(studio, name), { recursive: true });
    }
    const fixtureManifest = JSON.parse(await readFile(path.join(studio, 'dependency-attribution.json'), 'utf8'));
    fixtureManifest.packageNoticeEvidence = [];
    await writeFile(path.join(studio, 'dependency-attribution.json'), JSON.stringify(fixtureManifest));
    const dist = path.join(directory, 'dist');
    await mkdir(dist);
    await mkdir(path.join(directory, 'node_modules/example'), { recursive: true });
    const lock = { packages: { '': {}, 'node_modules/example': { version: '1.2.3', license: 'MIT' }, 'node_modules/missing-notice': { version: '1.0.0' } } };
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
    await writeFile(path.join(studio, 'engine-package-lock.json'), JSON.stringify(lock));
    await mkdir(path.join(directory, 'node_modules/missing-notice'), { recursive: true });
    await writeFile(path.join(directory, 'node_modules/missing-notice/package.json'), JSON.stringify({ version: '1.0.0' }));
    await writeFile(path.join(directory, 'node_modules/example/package.json'), JSON.stringify({ version: '1.2.3' }));
    await writeFile(path.join(directory, 'node_modules/example/LICENSE'), 'Package copyright and license');
    await packageAttribution(studio, dist, directory);
    const output = JSON.parse(await readFile(path.join(dist, 'attribution/index.json'), 'utf8'));
    assert.equal(output.packages[0].status, 'notice-files-collected');
    const file = output.packages[0].notices[0].file;
    assert.equal(await readFile(path.join(dist, 'attribution', file), 'utf8'), 'Package copyright and license');
    await rm(path.join(dist, 'attribution', file));
    await symlink(path.join(directory, 'node_modules/example/LICENSE'), path.join(dist, 'attribution', file));
    await assert.rejects(auditAttribution(studio, dist, directory), /Linked attribution/);
    await writeFile(path.join(directory, 'node_modules/example/package.json'), JSON.stringify({ version: '9.9.9' }));
    await assert.rejects(packageAttribution(studio, dist, directory), /Package version changed/);
    await writeFile(path.join(directory, 'node_modules/example/package.json'), JSON.stringify({ version: '1.2.3' }));
    const receipt = await packageAttribution(studio, dist, directory);
    assert.deepEqual(receipt.unresolvedPackages, ['node_modules/missing-notice']);
    // Matching edits must not hide an installed package with no collected notice.
    delete lock.packages['node_modules/missing-notice'];
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
    output.packages = output.packages.filter(({ location }) => location !== 'node_modules/missing-notice');
    await writeFile(path.join(dist, 'attribution/index.json'), JSON.stringify(output));
    await assert.rejects(auditAttribution(studio, dist, directory), /Generated lockfile differs from pinned package authority/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('runtime policy admits exactly the owner-approved rows and keeps everything else blocked', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-runtime-policy-'));
  try {
    const studio = path.resolve(import.meta.dirname, '..');
    await cp(path.join(studio, 'runtime'), path.join(root, 'runtime'), { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(studio, 'dependency-attribution.json'), 'utf8'));
    const approval = JSON.parse(await readFile(path.join(studio, 'rights-approval.json'), 'utf8'));
    await writeFile(path.join(root, 'dependency-attribution.json'), JSON.stringify(manifest));
    const engine = path.join(root, 'engine');
    const policyOf = async () => JSON.parse(await readFile(path.join(engine, 'src/shared/utils/resource-policy.json'), 'utf8'));

    // Without the owner's approval nothing is admitted.
    await writeResourcePolicy(root, engine);
    let actual = await policyOf();
    assert.deepEqual(Object.keys(actual), manifest.resources.map(({ id }) => id));
    assert.equal(Object.keys(actual).length, 210);
    assert.ok(Object.values(actual).every((entry) => entry.localRuntime === 'blocked' && entry.approvalSha256 === null));

    // With it, every approved row is admitted, bound to its row digest and pinned revision.
    await writeFile(path.join(root, 'rights-approval.json'), JSON.stringify(approval));
    await writeResourcePolicy(root, engine);
    actual = await policyOf();
    // Every row, including the bundled runtimes and the commit-pinned TTS rows the owner approved
    // on 2026-09-29.
    for (const [id, entry] of Object.entries(actual)) {
      assert.ok(entry.localRuntime === 'allowed' && /^[a-f0-9]{64}$/.test(entry.approvalSha256), id);
    }
    // Supertonic and every voice are admitted only at their pinned commits.
    const pinned = manifest.resources.filter(({ id }) => /^voice:(kokoro|supertonic)-|^model:supertonic-3$/.test(id));
    assert.equal(pinned.length, 65);
    assert.ok(pinned.every(({ revision, files }) => /^[a-f0-9]{40}$/.test(revision) && files.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256))));
    assert.ok(Object.values(actual).every((entry) => entry.sha256 === null));
    const { files: rifeFiles, ...rifePolicy } = actual['model:walterlow/RIFE_fp32_timestep'];
    assert.deepEqual(rifePolicy, {
      localRuntime: 'allowed',
      approvalSha256: approval.resources.find(({ id }) => id === 'model:walterlow/RIFE_fp32_timestep').sha256,
      sha256: null,
      locator: 'walterlow/RIFE_fp32_timestep',
      revision: 'ee09066f9822f8b28b8477a1b4cc30f19d607590',
    });
    assert.deepEqual(rifeFiles, {}, 'RIFE has a null payload hash, so no file bytes are admitted');
    assert.deepEqual(await readFile(path.join(engine, 'src/shared/utils/resource-policy.json')), await readFile(path.join(engine, 'public/moss-tts/resource-policy.json')));

    // The runtime module admits ids and URLs only inside approved rows and pinned revisions.
    const runtime = await import(`${path.join(engine, 'src/shared/utils/resource-admission.mjs')}?approved`);
    for (const id of [
      'font:Inter',
      'model:walterlow/RIFE_fp32_timestep',
      'https://huggingface.co/walterlow/RIFE_fp32_timestep/resolve/ee09066f9822f8b28b8477a1b4cc30f19d607590/RIFE_fp32_timestep.onnx',
      'model:supertonic-3',
      'voice:supertonic-F1',
      'voice:kokoro-af_heart',
      'https://huggingface.co/spaces/Supertone/supertonic-3/resolve/4402acca094e2ff2b3dff446e0bf915f3fccc462/assets/onnx/vocoder.onnx',
      'https://huggingface.co/spaces/Supertone/supertonic-3/resolve/4402acca094e2ff2b3dff446e0bf915f3fccc462/assets/voice_styles/F1.json',
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_heart.bin',
    ]) assert.equal(runtime.canUseResource(id), true, id);
    assert.equal(runtime.approvedRevision('model:supertonic-3'), '4402acca094e2ff2b3dff446e0bf915f3fccc462');
    // Whisper, Parakeet, RIFE and Supertonic run on the re-approved bundled runtimes; the old CDN
    // locators are nobody's approval any more.
    for (const id of ['runtime:onnx-cdn', 'runtime:whisper-transformers']) assert.equal(runtime.canUseResource(id), true, id);
    assert.equal(runtime.canUseResource('https://esm.sh/@huggingface/transformers@3.8.1?bundle'), false);
    assert.equal(runtime.canUseResource('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260410-5e55544225/dist/ort-wasm-simd-threaded.jsep.wasm'), false);
    for (const id of [
      'font:Not A Reviewed Font',
      'model:unknown/weights',
      'https://huggingface.co/walterlow/RIFE_fp32_timestep/resolve/main/RIFE_fp32_timestep.onnx',
      'https://huggingface.co/walterlow/RIFE_fp32_timestep/resolve/ee09066f9822f8b28b8477a1b4cc30f19d607590/../../other/resolve/x/a.onnx',
      'https://user:pass@huggingface.co/walterlow/RIFE_fp32_timestep/resolve/ee09066f9822f8b28b8477a1b4cc30f19d607590/a.onnx',
      'http://huggingface.co/walterlow/RIFE_fp32_timestep/resolve/ee09066f9822f8b28b8477a1b4cc30f19d607590/a.onnx',
      'https://huggingface.co.evil.test/walterlow/RIFE_fp32_timestep/resolve/ee09066f9822f8b28b8477a1b4cc30f19d607590/a.onnx',
      'https://huggingface.co/unapproved/resolve/main/model.onnx',
      'https://huggingface.co/walterlow/RIFE_fp32_timestep-evil/resolve/ee09066f9822f8b28b8477a1b4cc30f19d607590/a.onnx',
      'https://huggingface.co/spaces/Supertone/supertonic-3/resolve/main/assets-evil/x.onnx',
      // Supertonic and the voices are never admitted from the moving branch.
      'https://huggingface.co/spaces/Supertone/supertonic-3/resolve/main/assets/onnx/vocoder.onnx',
      'https://huggingface.co/spaces/Supertone/supertonic-3/resolve/main/assets/voice_styles/F1.json',
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin',
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260410-5e55544225/dist/..%2F..%2Fevil@1%2Fx.js',
    ]) assert.equal(runtime.canUseResource(id), false, id);
    // Third-party loaders that ask for a branch are sent to the approved commit; nothing else moves.
    assert.equal(
      runtime.pinnedHuggingFaceUrl('https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin'),
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_heart.bin',
    );
    assert.equal(
      runtime.pinnedHuggingFaceUrl('https://huggingface.co/api/models/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/tree/main?recursive=1'),
      'https://huggingface.co/api/models/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/tree/f52645cb467506d8e18e746ddd59482685b74e58?recursive=1',
    );
    for (const unchanged of [
      'https://huggingface.co/unapproved/repo/resolve/main/model.onnx',
      'https://huggingface.co/spaces/Supertone/supertonic-3/resolve/main/assets/onnx/vocoder.onnx',
      'https://fonts.googleapis.com/css2?family=Inter',
    ]) assert.equal(runtime.pinnedHuggingFaceUrl(unchanged), unchanged);
    assert.equal(runtime.approvedRevision('model:Xenova/musicgen-small'), '6a8096dabfff72909ef5eae41461408e29ae20fd');
    assert.throws(() => runtime.approvedRevision('font:Inter'), /FRAMELEAF_RESOURCE_BLOCKED/);
    // The font row has no per-file byte digest, so byte verification still fails closed.
    await assert.rejects(runtime.verifyResourceBytes('font:Inter', new Uint8Array([1])), /FRAMELEAF_RESOURCE_BLOCKED/);

    // A re-approval must say where it is recorded.
    const unsourced = structuredClone(approval);
    delete unsourced.resources.find(({ id }) => id === 'runtime:onnx-cdn').source;
    await writeFile(path.join(root, 'rights-approval.json'), JSON.stringify(unsourced));
    await assert.rejects(writeResourcePolicy(root, path.join(root, 'engine-unsourced')), /must say where its own approval is recorded/);

    // A use the owner withheld, or a row changed after approval, stays blocked.
    const withheld = structuredClone(approval);
    withheld.resources.find(({ id }) => id === 'font:Inter').excludedUses = { localRuntime: 'Withheld for this test.' };
    withheld.resources.find(({ id }) => id === 'voice:kokoro-af_heart').excludedUses = { localRuntime: 'Withheld for this test.' };
    const changed = structuredClone(manifest);
    changed.resources.find(({ id }) => id === 'model:walterlow/RIFE_fp32_timestep').revision = '0'.repeat(40);
    await writeFile(path.join(root, 'rights-approval.json'), JSON.stringify(withheld));
    await writeFile(path.join(root, 'dependency-attribution.json'), JSON.stringify(changed));
    // A separate engine directory, so the runtime module reads this policy rather than a cached one.
    const narrowedEngine = path.join(root, 'engine-withheld');
    await writeResourcePolicy(root, narrowedEngine);
    actual = JSON.parse(await readFile(path.join(narrowedEngine, 'src/shared/utils/resource-policy.json'), 'utf8'));
    assert.equal(actual['font:Inter'].localRuntime, 'blocked');
    assert.equal(actual['model:walterlow/RIFE_fp32_timestep'].localRuntime, 'blocked');
    assert.equal(actual['font:Roboto'].localRuntime, 'allowed');
    assert.equal(actual['voice:kokoro-af_heart'].localRuntime, 'blocked');
    // A withheld voice blocks its own file even though its model repository is approved.
    const narrowed = await import(path.join(narrowedEngine, 'src/shared/utils/resource-admission.mjs'));
    assert.equal(narrowed.canUseResource('voice:kokoro-af_heart'), false);
    assert.equal(narrowed.canUseResource('voice:kokoro-af_bella'), true);
    const kokoro = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve';
    assert.equal(narrowed.canUseResource(`${kokoro}/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_heart.bin`), false);
    assert.equal(narrowed.canUseResource(`${kokoro}/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_bella.bin`), true);
    assert.equal(narrowed.canUseResource(`${kokoro}/main/voices/af_bella.bin`), false);
    assert.equal(narrowed.canUseResource('https://huggingface.co/spaces/Supertone/supertonic-3/resolve/4402acca094e2ff2b3dff446e0bf915f3fccc462/assets/voice_styles/F1.json'), true);
    assert.equal(narrowed.approvedRevision('model:supertonic-3'), '4402acca094e2ff2b3dff446e0bf915f3fccc462');
    assert.equal(narrowed.canUseResource('model:walterlow/RIFE_fp32_timestep'), false);

    // A reviewed row cannot admit itself: approval is the owner's record, not a JSON edit.
    manifest.resources[0].decisions.localRuntime = 'allowed';
    await writeFile(path.join(root, 'dependency-attribution.json'), JSON.stringify(manifest));
    await assert.rejects(writeResourcePolicy(root, engine), /Unreviewed runtime approval/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file byte admission uses actual generated owner-bound policy; synthetic approvals are not production authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-file-policy-contract-'));
  const revision = 'a'.repeat(40);
  const bytes = new Uint8Array([1, 2, 3]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const base = `https://huggingface.co/synthetic-contract/model/resolve/${revision}`;
  const row = () => ({ id: 'model:synthetic-contract/model', kind: 'model', locator: 'synthetic-contract/model', revision, licenseDeclared: 'Synthetic contract only', decisions: { redistribution: 'blocked', localRuntime: 'blocked', hostedUse: 'blocked' }, files: [{ path: 'weights.bin', sha256: digest }, { path: 'config.json', sha256: null }] });
  let sequence = 0;
  try {
    await cp(path.resolve(import.meta.dirname, '../runtime'), path.join(root, 'runtime'), { recursive: true });
    const prepare = async (rows, mutateApproval = () => {}, mutateRows = () => {}) => {
      const manifest = { schemaVersion: 1, resources: rows };
      const approval = { schemaVersion: 1, approvedBy: 'Synthetic test fixture', approvedOn: '2026-10-03', source: 'Authored rejection contract; no production approval', uses: ['localRuntime'], resources: rows.map((resource) => ({ id: resource.id, sha256: approvalRowDigest(resource) })) };
      mutateApproval(approval); mutateRows(rows);
      await writeFile(path.join(root, 'dependency-attribution.json'), JSON.stringify(manifest));
      await writeFile(path.join(root, 'rights-approval.json'), JSON.stringify(approval));
      const engine = path.join(root, `engine-${sequence++}`);
      await writeResourcePolicy(root, engine);
      return import(path.join(engine, 'src/shared/utils/resource-admission.mjs'));
    };
    const runtime = await prepare([row()]);
    assert.equal(runtime.requireResource(row().id).sha256, null);
    assert.deepEqual(await runtime.verifyResourceBytes(`${base}/weights.bin`, bytes), bytes);
    for (const id of [row().id, base, `${base}/`, `${base}/config.json`, `${base}/unknown.bin`, `${base}/WEIGHTS.bin`, `${base}/weights.bin?download=1`, `${base}/weights.bin#fragment`, `${base}/%77eights.bin`, `${base}/a%2fweights.bin`, `${base}/a%5cweights.bin`, `${base}/a%252fweights.bin`, `${base}/../weights.bin`, `${base}/a/../weights.bin`, `${base}/%2e%2e/weights.bin`, base.replace(revision, revision.toUpperCase()) + '/weights.bin', base.replace(revision, 'main') + '/weights.bin', base.replace('huggingface.co', 'huggingface.co.evil.test') + '/weights.bin']) {
      await assert.rejects(runtime.verifyResourceBytes(id, bytes), /FRAMELEAF_RESOURCE_BLOCKED/, id);
    }
    await assert.rejects(runtime.verifyResourceBytes(`${base}/weights.bin`, new Uint8Array([1, 2, 4])), /FRAMELEAF_RESOURCE_BLOCKED/);
    const mutable = bytes.slice();
    const pending = runtime.verifyResourceBytes(`${base}/weights.bin`, mutable);
    mutable.fill(0);
    assert.deepEqual(await pending, bytes, 'Caller mutation after digest begins must not alter admitted bytes');
    const buffer = bytes.slice().buffer;
    const pendingBuffer = runtime.verifyResourceBytes(`${base}/weights.bin`, buffer);
    new Uint8Array(buffer).fill(0);
    assert.deepEqual(await pendingBuffer, bytes);

    // An exact voice row controls its file even inside an admitted model repository.
    const voice = { ...row(), id: 'voice:synthetic-specific-file', kind: 'voice', locator: `${base}/weights.bin`, files: [{ path: 'weights.bin', sha256: digest }] };
    const specific = await prepare([row(), voice]);
    assert.equal(specific.requireResource(`${base}/weights.bin`).approvalSha256, approvalRowDigest(voice));
    assert.deepEqual(await specific.verifyResourceBytes(`${base}/weights.bin`, bytes), bytes);
    const blocked = await prepare([row(), voice], (approval) => { approval.resources[1].excludedUses = { localRuntime: 'Synthetic explicit refusal' }; });
    await assert.rejects(blocked.verifyResourceBytes(`${base}/weights.bin`, bytes), /FRAMELEAF_RESOURCE_BLOCKED/);
    for (const mutate of [
      (rows) => { rows[0].revision = 'b'.repeat(40); },
      (rows) => { rows[0].files[0].sha256 = '0'.repeat(64); },
      (rows) => { rows[0].files[0].path = 'other.bin'; },
      (rows) => { rows[0].locator = 'synthetic-contract/other'; },
    ]) {
      const changed = await prepare([row()], undefined, mutate);
      await assert.rejects(changed.verifyResourceBytes(`${base}/weights.bin`, bytes), /FRAMELEAF_RESOURCE_BLOCKED/);
    }
    for (const mutate of [
      (approval) => { approval.resources = []; },
      (approval) => { approval.uses = ['hostedUse']; },
      (approval) => { approval.resources[0].excludedUses = { localRuntime: 'Synthetic refusal' }; },
      (approval) => { approval.resources[0].sha256 = '0'.repeat(64); },
    ]) {
      const refused = await prepare([row()], mutate);
      await assert.rejects(refused.verifyResourceBytes(`${base}/weights.bin`, bytes), /FRAMELEAF_RESOURCE_BLOCKED/);
    }
    const missing = row(); missing.files[0].sha256 = null;
    await assert.rejects((await prepare([missing])).verifyResourceBytes(`${base}/weights.bin`, bytes), /FRAMELEAF_RESOURCE_BLOCKED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('current Whisper file inventory is exact and bound to the renewed owner approval', async () => {
  const manifest = JSON.parse(await readFile(new URL('../dependency-attribution.json', import.meta.url), 'utf8'));
  const record = JSON.parse(await readFile(new URL('../rights-approval.json', import.meta.url), 'utf8'));
  const inventory = JSON.parse(await readFile(new URL('../qualification-evidence/whisper-37164769288-candidates.json', import.meta.url), 'utf8'));
  const id = 'model:onnx-community/whisper-tiny_timestamped';
  const resource = manifest.resources.find((row) => row.id === id);
  const entry = record.resources.find((row) => row.id === id);
  assert.equal(resource.locator, inventory.locator);
  assert.equal(resource.revision, '517244293732ee2d58139af5814231b7e6830a0d');
  assert.deepEqual(resource.files.map(({ path }) => path), [
    'config.json', 'tokenizer_config.json', 'preprocessor_config.json', 'generation_config.json',
    'tokenizer.json', 'onnx/encoder_model.onnx', 'onnx/decoder_model_merged_q4.onnx',
  ]);
  assert.deepEqual(resource.files, inventory.candidates.map(({ path, observedSha256 }) => ({ path, sha256: observedSha256 })));
  assert.equal(entry.sha256, approvalRowDigest(resource));
  assert.equal(entry.sha256, '80e61764717ea2f274fa12ab2e9a9b0bb4fc0e8cb1f41ba9a32ef67279cfc3f5');
  assert.equal(entry.approvedOn, '2026-10-03');
  assert.match(entry.source, /Approve this exact seven-file inventory/);
  assert.match(entry.source, /37164769288/);
  const approval = ownerApproval(record, manifest);
  assert.equal(approval.approved.get(id), true);
  assert(approval.uses.includes('localRuntime'));
  assert(!Object.hasOwn(approval.excluded.get(id) ?? {}, 'localRuntime'));
  const changed = structuredClone(manifest);
  changed.resources.find((row) => row.id === id).files[0].sha256 = '0'.repeat(64);
  assert.equal(ownerApproval(record, changed).approved.get(id), false);
});

test('retained Whisper payload candidates match genuine diagnostic provenance and remain unsigned/unapproved', async () => {
  const reportBytes = await readFile(new URL('../qualification-evidence/whisper-37164769288-diagnostic.json', import.meta.url));
  const report = JSON.parse(reportBytes.toString('utf8'));
  const inventory = JSON.parse(await readFile(new URL('../qualification-evidence/whisper-37164769288-candidates.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(reportBytes).digest('hex'), inventory.source.reportSha256);
  assert.equal(inventory.source.reportSha256, '63cc58638218ec4c4cb9807a015cd44e0537fa0c190899457ded0ccb67277153');
  assert.equal(inventory.approval, 'UNAPPROVED'); assert.equal(inventory.signature, null);
  assert.equal(inventory.source.run, report.run); assert.equal(inventory.source.sourceCommit, report.sourceCommit);
  assert.equal(inventory.revision, report.revision); assert.equal(inventory.source.observationCount, report.payloads.length);
  assert.equal(inventory.source.distinctPayloadCount, new Set(report.payloads.map(({ origin }) => origin)).size);
  assert.equal(inventory.candidates.length, inventory.source.distinctPayloadCount);
  assert(report.payloads.every(({ approvedPayloadDigest }) => approvedPayloadDigest === null));
  for (const candidate of inventory.candidates) {
    const observations = report.payloads.filter(({ origin }) => origin === candidate.origin);
    assert.equal(candidate.observations, observations.length); assert.equal(candidate.approvedPayloadDigest, null);
    assert.equal(candidate.origin, `https://huggingface.co/${inventory.locator}/resolve/${inventory.revision}/${candidate.path}`);
    for (const observation of observations) {
      for (const key of ['responseOrigin', 'bytes', 'observedSha256']) assert.equal(candidate[key], observation[key]);
      assert.equal(observation.revision, inventory.revision);
    }
  }
});

test('file policy generator rejects malformed schema, duplicate identities and nonliteral paths before output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-file-schema-contract-'));
  try {
    const resource = { id: 'model:synthetic-contract/model', kind: 'model', locator: 'synthetic-contract/model', revision: 'a'.repeat(40), files: [{ path: 'weights.bin', sha256: 'b'.repeat(64) }], decisions: { redistribution: 'blocked', localRuntime: 'blocked', hostedUse: 'blocked' } };
    for (const mutate of [
      (manifest) => { manifest.schemaVersion = 2; },
      (manifest) => { manifest.resources.push(structuredClone(resource)); },
      ...['../weights.bin', 'a/../weights.bin', './weights.bin', '/weights.bin', 'a//weights.bin', 'weights.bin?download=1', 'weights.bin#fragment', 'a%2fweights.bin', 'a%5cweights.bin', 'a\\weights.bin', 'https://example.test/weights.bin'].map((name) => (manifest) => { manifest.resources[0].files[0].path = name; }),
      (manifest) => { manifest.resources[0].files.push({ ...resource.files[0] }); },
      (manifest) => { delete manifest.resources[0].files[0].sha256; },
      (manifest) => { manifest.resources[0].files[0].sha256 = 'B'.repeat(64); },
      (manifest) => { manifest.resources[0].files[0].sha256 = 'not-a-hash'; },
      (manifest) => { manifest.resources[0].files[0].url = 'https://unapproved.test/weights.bin'; },
      (manifest) => { manifest.resources[0].files = null; },
    ]) {
      const manifest = { schemaVersion: 1, resources: [structuredClone(resource)] }; mutate(manifest);
      await writeFile(path.join(root, 'dependency-attribution.json'), JSON.stringify(manifest));
      await assert.rejects(writeResourcePolicy(root, path.join(root, 'must-not-generate')));
      await assert.rejects(readFile(path.join(root, 'must-not-generate/src/shared/utils/resource-policy.json')), { code: 'ENOENT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('supplemental notices require exact package bindings and retained evidence; partial native evidence stays blocked', async () => {
  const { packageAttribution, auditAttribution } = await import('./attribution.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-supplemental-notices-'));
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  try {
    const studio = path.join(root, 'studio');
    const engine = path.join(root, 'engine');
    const dist = path.join(root, 'dist');
    for (const directory of [studio, dist, path.join(engine, 'node_modules/example'), path.join(engine, 'node_modules/native')]) await mkdir(directory, { recursive: true });
    const license = 'Synthetic test copyright and license';
    const evidence = 'Synthetic exact-version source receipt';
    await writeFile(path.join(studio, 'license.txt'), license);
    await writeFile(path.join(studio, 'evidence.json'), evidence);
    const pkg = { version: '1.2.3', integrity: 'sha512-fixture', resolved: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz' };
    const lock = { packages: { '': {}, 'node_modules/example': pkg, 'node_modules/native': pkg } };
    for (const name of ['example', 'native']) await writeFile(path.join(engine, 'node_modules', name, 'package.json'), JSON.stringify({ version: pkg.version }));
    for (const directory of [studio, engine]) await writeFile(path.join(directory, directory === studio ? 'engine-package-lock.json' : 'package-lock.json'), JSON.stringify(lock));
    const binding = { location: 'node_modules/example', ...pkg, noticeIds: ['supplement'], unresolved: null, evidence: [{ path: 'evidence.json', sha256: hash(evidence), sourceUrl: 'https://example.invalid/exact-version' }] };
    const manifest = { engineRevision: 'fixture', embeddedComponents: [], dolbyTools: {}, rightsPolicy: { distributionApproval: false }, resources: [], artifactNotices: [{ id: 'supplement', path: 'license.txt', sha256: hash(license) }], packageNoticeEvidence: [binding, { ...binding, location: 'node_modules/native', unresolved: 'Native constituents remain unmapped.' }] };
    const save = () => writeFile(path.join(studio, 'dependency-attribution.json'), JSON.stringify(manifest));
    await save();
    const receipt = await packageAttribution(studio, dist, engine);
    assert.deepEqual(receipt.unresolvedPackages, ['node_modules/native']);
    assert.equal(receipt.distributionApproval, false);
    const output = JSON.parse(await readFile(path.join(dist, 'attribution/index.json'), 'utf8'));
    assert.equal(output.packages[0].notices[0].file, 'supplement.txt');
    assert.equal(output.packages[1].noticeEvidence.unresolved, 'Native constituents remain unmapped.');
    await auditAttribution(studio, dist, engine);
    await writeFile(path.join(dist, 'attribution/supplement.txt'), 'tampered output');
    await assert.rejects(auditAttribution(studio, dist, engine), /notice changed/);
    for (const field of ['version', 'integrity', 'resolved']) {
      const original = binding[field];
      binding[field] = 'substituted';
      await save();
      await assert.rejects(packageAttribution(studio, dist, engine), /Package notice binding changed/);
      binding[field] = original;
    }
    binding.noticeIds = ['unknown'];
    await save();
    await assert.rejects(packageAttribution(studio, dist, engine), /Unknown package notice/);
    binding.noticeIds = ['supplement'];
    manifest.packageNoticeEvidence.push(binding);
    await save();
    await assert.rejects(packageAttribution(studio, dist, engine), /Duplicate package notice binding/);
    manifest.packageNoticeEvidence.pop();
    binding.location = 'node_modules/absent';
    await save();
    await assert.rejects(packageAttribution(studio, dist, engine), /Unknown package notice binding/);
    binding.location = 'node_modules/example';
    await save();
    await writeFile(path.join(studio, 'evidence.json'), 'tampered evidence');
    await assert.rejects(packageAttribution(studio, dist, engine), /Package notice evidence changed/);
    await rm(path.join(studio, 'evidence.json'));
    await symlink(path.join(studio, 'license.txt'), path.join(studio, 'evidence.json'));
    await assert.rejects(packageAttribution(studio, dist, engine), /Linked attribution/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Synthetic helper evidence; the real adapted inventory is produced only by hosted prepare.
test('a mismatched adapted digest preserves genuine observation but refuses publication', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-source-recovery-'));
  const file = path.join(directory, 'receipt.json');
  const source = [{ path: 'src/entry.ts', sha256: '1'.repeat(64) }];
  let published = false;
  try {
    await assert.rejects(async () => {
      await admitAdaptedSource(source, '0'.repeat(64), async (receipt) => {
        await writeFile(file, JSON.stringify(receipt));
      });
      published = true;
    }, /Adapted source digest mismatch/);
    assert.equal(published, false);
    const receipt = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(receipt.files, source);
    assert.equal(receipt.sourceSha256, createHash('sha256').update(JSON.stringify(source)).digest('hex'));
    assert.equal(receipt.digestMatched, false);
    const expected = receipt.sourceSha256;
    let matching;
    assert.equal(await admitAdaptedSource(source, expected, async (value) => { matching = value; }), expected);
    assert.equal(matching.digestMatched, true);
    assert.equal(await admitAdaptedSource(source, expected), expected);
    await assert.rejects(admitAdaptedSource(source, '0'.repeat(64)), /Adapted source digest mismatch/);
    await assert.rejects(admitAdaptedSource(source, expected, async () => { throw new Error('receipt failed'); }), /receipt failed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('source recovery is explicit hosted-only fixed-path metadata with no environment disclosure', () => {
  const checkout = { head: '1'.repeat(40), tree: '2'.repeat(40), parents: ['3'.repeat(40), '4'.repeat(40)] };
  const environment = {
    STUDIO_SOURCE_RECOVERY: '1', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Frameleaf/frameleaf-app',
    RUNNER_TEMP: '/tmp/hosted-runner', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'engine',
    REVIEWED_HEAD: '5'.repeat(40), PRIVATE_SENTINEL: 'NEVER-EXPORT',
  };
  assert.equal(sourceRecoveryContext({}, undefined), null);
  const receipt = sourceRecoveryContext(environment, checkout);
  assert.equal(receipt.file, '/tmp/hosted-runner/frameleaf-studio-source-recovery.json');
  assert.deepEqual(receipt.producer.checkoutParents, checkout.parents);
  assert.equal(receipt.producer.checkoutTree, checkout.tree);
  assert.equal(JSON.stringify(receipt).includes('NEVER-EXPORT'), false);
  for (const update of [
    { STUDIO_SOURCE_RECOVERY: 'yes' }, { GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'other/repo' },
    { RUNNER_TEMP: 'relative' }, { GITHUB_RUN_ID: 'secret' }, { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_JOB: 'secret' }, { REVIEWED_HEAD: 'wrong' },
  ]) assert.throws(() => sourceRecoveryContext({ ...environment, ...update }, checkout));
  assert.throws(() => sourceRecoveryContext(environment, { ...checkout, parents: ['not-a-sha'] }));
});
