// Explicit local container fixture: execute with a disposable /data mount and no network.
// Exercises the compiled preboot authority, not API/DB/Cloud acceptance.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuddyRecoveryFiles, readBuddyRecovery } from '../../dist/utils/buddy-backup-recovery.js';
import {
  prepareBuddyBootBinding,
  finalizeBuddyBootBinding,
  loadBuddyBootBinding,
  revokeBuddyBootBinding,
} from '../../dist/utils/buddy-boot-binding.js';
import {
  captureBuddyBootConfiguration,
  stageBuddyBootConfiguration,
} from '../../dist/utils/buddy-boot-configuration.js';

assert.equal(process.env.FRAMELEAF_BOOT_DEFAULT_FIXTURE, '1', 'Dedicated disposable container mount required');
assert(process.platform === 'linux' && existsSync('/.dockerenv'), 'Owned local container only');
const storageRoot = process.env.FRAMELEAF_BOOT_DEFAULT_ROOT ?? '/data';
assert(['/data', '/usr/src/app/upload'].includes(storageRoot));
const root = '/fixture/default-boot-fixture';
const id = randomUUID();
const directory = join(root, 'recovery', id);
const identity = join(root, 'identity');
const binding = join(identity, 'buddy-boot-binding.json');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refusal = /Invalid replacement-local Buddy boot authority/;
if (process.env.FRAMELEAF_BOOT_DEFAULT_ACTION) {
  const saved = JSON.parse(await readFile(join(root, 'fixture.json')));
  process.env.FRAMELEAF_IDENTITY_DIR = saved.identity;
  process.env.FRAMELEAF_BUDDY_BOOT_BINDING_FILE = saved.binding;
  const before = JSON.stringify(process.env);
  const publication = await readFile(join(saved.directory, 'publication.json'));
  if (process.env.FRAMELEAF_BOOT_DEFAULT_ACTION === 'refuse-missing') {
    assert(!existsSync('/data') && !existsSync('/usr/src/app/upload'));
  }
  if (process.env.FRAMELEAF_BOOT_DEFAULT_ACTION.startsWith('refuse'))
    await assert.rejects(loadBuddyBootBinding(), refusal);
  else await loadBuddyBootBinding();
  assert.equal(JSON.stringify(process.env), before);
  assert((await readFile(join(saved.directory, 'publication.json'))).equals(publication));
  if (process.env.FRAMELEAF_BOOT_DEFAULT_ACTION === 'refuse-missing') {
    assert(!existsSync('/data') && !existsSync('/usr/src/app/upload'));
  }
  console.log('fresh compiled mount control PASS');
  process.exit(0);
}

await chmod(storageRoot, 0o700);
for (const path of [root, directory, join(directory, 'objects'), identity])
  await mkdir(path, { recursive: true, mode: 0o700 });
const { privateKey } = generateKeyPairSync('ed25519');
await writeFile(join(identity, 'instance-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), {
  mode: 0o600,
});
process.env.FRAMELEAF_IDENTITY_DIR = identity;
process.env.FRAMELEAF_BUDDY_BOOT_BINDING_FILE = binding;
delete process.env.FRAMELEAF_MEDIA_LOCATION;
delete process.env.IMMICH_MEDIA_LOCATION;
const configuration = captureBuddyBootConfiguration({ version: 1, environmentKeys: ['FRAMELEAF_MEDIA_LOCATION'] });
assert.deepEqual(configuration.entries, [{ key: 'FRAMELEAF_MEDIA_LOCATION', state: 'unset' }]);
await stageBuddyBootConfiguration(directory, id, configuration);
const bytes = Buffer.from('synthetic recovered settings');
const target = join(root, 'settings.json');
const file = { role: 'configuration', path: target, sha256: digest(bytes), size: bytes.length, mtime: null };
await writeFile(join(directory, 'objects', file.sha256), bytes, { mode: 0o600 });
const plan = {
  version: 1,
  scope: 'server',
  mode: 'replace',
  manifest: {
    version: 1,
    vaultId: randomUUID(),
    snapshotId: id,
    storageRoot,
    storageRoots: [storageRoot],
    library: {
      version: 2,
      assets: {},
      database: { key: 'database.sql.gz', sha256: digest(bytes), size: bytes.length },
    },
    contents: {},
    assetLinks: {},
    assetFiles: {},
    dependencies: [],
    configurationFiles: [file],
    bootConfiguration: configuration,
    settings: { system: {}, users: [] },
  },
  files: [file],
};
await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan), { mode: 0o600 });
const files = new BuddyRecoveryFiles(root, id, async () => {});
await files.state('publishing');
await files.publish(await readBuddyRecovery(root, id), [], [target]);
await files.verify(plan, [], [target]);
await files.state('complete');
assert((await readFile(target)).equals(bytes));
const metadata = await lstat(storageRoot, { bigint: true });
const profile = join(identity, 'mount-profile.json');
const mounts = { roots: [{ path: storageRoot, device: String(metadata.dev), inode: String(metadata.ino) }] };
await writeFile(profile, JSON.stringify(mounts), { mode: 0o600 });
// Actual compiled prepare is the baseline RED: captured UNSET resolves to mounted /data.
await prepareBuddyBootBinding(binding, directory, ['FRAMELEAF_MEDIA_LOCATION'], undefined, profile);
assert.equal(JSON.parse(await readFile(binding)).state, 'request');
const marker = join(identity, 'buddy', 'recovery-active.json');
await mkdir(join(identity, 'buddy'), { mode: 0o700 });
const markerValue = { isMaintenanceMode: true, secret: randomUUID(), action: { buddyRecoveryId: id } };
await writeFile(marker, JSON.stringify(markerValue), { mode: 0o600 });
await finalizeBuddyBootBinding(root, id, async () => {});
assert.equal(JSON.parse(await readFile(binding)).state, 'ready');
await loadBuddyBootBinding(); // maintenance does not activate historical settings
await rm(marker);
await loadBuddyBootBinding();
assert.equal(process.env.FRAMELEAF_MEDIA_LOCATION, undefined);
assert.equal(process.env.IMMICH_MEDIA_LOCATION, undefined);
const childCode = `import {loadBuddyBootBinding} from ${JSON.stringify(fileURLToPath(new URL('../../dist/utils/buddy-boot-binding.js', import.meta.url)))}; await loadBuddyBootBinding(); if(process.env.FRAMELEAF_MEDIA_LOCATION!==undefined||process.env.IMMICH_MEDIA_LOCATION!==undefined) throw Error('UNSET changed'); const {ConfigRepository}=await import(${JSON.stringify(fileURLToPath(new URL('../../dist/repositories/config.repository.js', import.meta.url)))}); const {discoverMediaLocation}=await import(${JSON.stringify(fileURLToPath(new URL('../../dist/utils/media-location.js', import.meta.url)))}); const {existsSync}=await import('node:fs'); const config=new ConfigRepository(); const first=config.getEnv(); if(first.storage.mediaLocation!==undefined||discoverMediaLocation(first.storage.mediaLocation,existsSync)!==${JSON.stringify(storageRoot)}||config.getEnv()!==first) throw Error('First config/default mismatch'); console.log('fresh compiled preboot/config PASS')`;
for (let n = 0; n < 2; n++) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, 'Fresh compiled authority must admit exact mounted default');
}
await writeFile(join(root, 'fixture.json'), JSON.stringify({ identity, binding, directory }), { mode: 0o600 });
const original = await readFile(binding);
const originalPublication = await readFile(join(directory, 'publication.json'));
const originalEnvironment = JSON.stringify(process.env);
const reject = async (label, change, restore) => {
  await change();
  const before = JSON.stringify(process.env);
  const publication = await readFile(join(directory, 'publication.json'));
  const beforeBinding = await readFile(binding);
  const hadMarker = existsSync(marker);
  if (!hadMarker) await writeFile(marker, JSON.stringify(markerValue), { mode: 0o600 });
  await assert.rejects(
    finalizeBuddyBootBinding(root, id, async () => {}),
    refusal,
    label,
  );
  assert((await readFile(binding)).equals(beforeBinding));
  if (!hadMarker) await rm(marker);
  await assert.rejects(loadBuddyBootBinding(), refusal, label);
  assert.equal(JSON.stringify(process.env), before);
  assert((await readFile(join(directory, 'publication.json'))).equals(publication));
  await restore();
};
const originalPrepared = await readFile(join(directory, 'prepared.json'));
// Keep must retain an explicit replacement value; replace intentionally removes it for captured UNSET.
await reject(
  'wrong explicit root retained by keep',
  async () => {
    process.env.FRAMELEAF_MEDIA_LOCATION = '/wrong';
    const kept = { ...plan, mode: 'keep' };
    const prepared = Buffer.from(JSON.stringify(kept));
    await writeFile(join(directory, 'prepared.json'), prepared);
    await writeFile(
      binding,
      JSON.stringify({ ...JSON.parse(original), mode: 'keep', preparedDigest: digest(prepared) }),
    );
  },
  async () => {
    delete process.env.FRAMELEAF_MEDIA_LOCATION;
    await writeFile(join(directory, 'prepared.json'), originalPrepared);
    await writeFile(binding, original);
  },
);
await reject(
  'conflicting aliases',
  async () => {
    process.env.FRAMELEAF_MEDIA_LOCATION = '/data';
    process.env.IMMICH_MEDIA_LOCATION = '/wrong';
  },
  async () => {
    delete process.env.FRAMELEAF_MEDIA_LOCATION;
    delete process.env.IMMICH_MEDIA_LOCATION;
  },
);
for (const field of ['device', 'inode'])
  await reject(
    `changed ${field}`,
    async () => {
      const value = JSON.parse(original);
      value.mountService.roots[0][field] = String(BigInt(value.mountService.roots[0][field]) + 1n);
      await writeFile(binding, JSON.stringify(value));
    },
    async () => {
      await writeFile(binding, original);
    },
  );
await reject(
  'revoked binding',
  async () => {
    await revokeBuddyBootBinding(binding);
  },
  async () => {
    await writeFile(binding, original);
  },
);
await reject(
  'wrong recovery marker',
  async () => {
    await writeFile(marker, JSON.stringify({ ...markerValue, action: { buddyRecoveryId: randomUUID() } }), {
      mode: 0o600,
    });
  },
  async () => {
    await rm(marker);
  },
);
await reject(
  'changed replacement identity',
  async () => {
    const value = JSON.parse(original);
    value.replacementIdentity = 'A'.repeat(43);
    await writeFile(binding, JSON.stringify(value));
  },
  async () => {
    await writeFile(binding, original);
  },
);
const originalKey = await readFile(join(identity, 'instance-key.pem'));
const moved = join(root, 'original-identity');
await reject(
  'symlink ancestry',
  async () => {
    await rename(identity, moved);
    await symlink(moved, identity);
  },
  async () => {
    await rm(identity);
    await rename(moved, identity);
  },
);
assert((await readFile(join(identity, 'instance-key.pem'))).equals(originalKey));
assert.equal(JSON.stringify(process.env), originalEnvironment);
assert((await readFile(join(directory, 'publication.json'))).equals(originalPublication));
console.log('compiled default prepare/finalize/load/restart and 8 negative fences PASS; UNSET preserved');
