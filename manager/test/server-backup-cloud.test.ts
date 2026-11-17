import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test, { after, before } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { standIn as storageStandIn } from '../../packages/backup-core/test/s3-stand-in.js';
import { Cloud, CloudError } from '../src/cloud-link.js';
import { CloudBackup } from '../src/server-backup-cloud.js';
import { DEFAULT_SETTINGS, ServerBackup, vaultOf, type Run } from '../src/server-backup.js';
import { Store } from '../src/store.js';
import { API, fixture, machine, standIn } from './cloud-stand-in.js';

// Two Managers, one Frameleaf Cloud account, one bucket: the first backs up, the second replaces it.
let root: string;
let storage: ReturnType<typeof storageStandIn>;
let cloud: ReturnType<typeof standIn>;
let key: string;
const stores: Store[] = [];
const at = (...names: string[]) => join(root, ...names);
const parts = (path: string) => path.split(sep).filter(Boolean);
const taxReturn = () => [...parts(at('server', 'documents', 'Tax')), 'Return 2025.xlsx'];

function manager(name: string) {
  const store = new Store(at(name));
  stores.push(store);
  const link = new CloudBackup(store, new Cloud(API, { fetch: cloud.fetch, now: () => cloud.state.now }), () => machine);
  const service = new ServerBackup(store, { target: null, cloud: link, inside: (path) => path === at('server') || path.startsWith(at('server') + sep), always: [] });
  return { link, service };
}
let first: ReturnType<typeof manager>;
let second: ReturnType<typeof manager>;

async function finished(service: ServerBackup): Promise<Run> {
  for (let tries = 0; tries < 1500; tries++) {
    if (!service.view()?.running) return service.runs(1)[0]!;
    await sleep(20);
  }
  throw new Error('The run did not finish');
}
async function until(what: () => boolean) {
  for (let tries = 0; tries < 200 && !what(); tries++) await sleep(20);
  assert.ok(what());
}
async function link({ link }: ReturnType<typeof manager>) {
  const started = await link.startLink();
  assert.equal(started.userCode, 'BCDF-GHJK');
  assert.equal(link.view().state, 'linking');
  assert.equal(await link.checkLink(), 'waiting');
  assert.equal(await link.checkLink(), 'linked');
  assert.deepEqual([link.view().state, link.view().account?.label], ['linked', 'Taylor household']);
}
const refused = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
const sequences = () => cloud.state.chain.map((item) => item.sequence);

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'manager-server-backup-cloud-')));
  await mkdir(at('server', 'documents', 'Tax'), { recursive: true });
  await mkdir(at('server', 'restored'));
  await writeFile(at('server', 'documents', 'Tax', 'Return 2025.xlsx'), 'the numbers '.repeat(4000));
  await writeFile(at('server', 'documents', 'notes.txt'), 'remember the milk');
  const grant = await fixture('capability-repository-upload.json');
  storage = storageStandIn({ bucket: grant.bucket, accessKeyId: grant.capability.credentials.accessKeyId });
  storage.server.listen(0, '127.0.0.1');
  await once(storage.server, 'listening');
  cloud = standIn();
  cloud.state.storage = { endpoint: `http://127.0.0.1:${(storage.server.address() as { port: number }).port}` };
  first = manager('first');
  second = manager('second');
});
after(async () => {
  for (const store of stores) store.close();
  storage.server.closeAllConnections();
  storage.server.close();
  await rm(root, { recursive: true, force: true });
});

test('nothing runs until this Manager is linked and knows where to store', async () => {
  assert.equal(first.service.view()?.state, 'off');
  await first.service.turnOn({ ...DEFAULT_SETTINGS, folders: [at('server', 'documents')] });
  key = await first.service.firstKey();
  await assert.rejects(first.service.backUp(), refused('server_backup_cloud_not_linked'));
  await link(first);
  await assert.rejects(first.service.backUp(), refused('server_backup_cloud_no_location'));
  assert.equal(cloud.state.lease, null);
  assert.deepEqual((await first.link.locations()).map((place) => place.locationId), ['loc-01']);
  first.link.setLocation('loc-01');
});

test('a backup goes to Cloud storage under the run lease and joins the signed history', async () => {
  await first.service.backUp();
  assert.equal(cloud.state.lease?.operation, 'backup');
  const run = await finished(first.service);
  assert.equal(run.state, 'done', run.error ?? '');
  await until(() => cloud.state.lease === null);

  // Everything sits under the vault that follows from the recovery key, and nothing there can be read.
  const vault = vaultOf(key);
  assert.ok(storage.objects.size >= 4);
  for (const [name, body] of storage.objects) {
    assert.match(name, new RegExp(`^r/v1/${vault}/(config|[pis]/[0-9a-f-]+)$`));
    assert.ok(!body.includes('the numbers') && !body.includes('Return 2025'));
  }
  // Only short-lived credentials ever reached storage.
  assert.ok(storage.seen.every((request) => request.token === 'synthetic-session-token-example'));

  const snapshot = first.service.view()!.snapshots[0]!.key;
  const record = cloud.state.chain[0]!.record as { descriptor: { sequence: number; manifest: { objectKey: string; versionId: string } } };
  assert.deepEqual(sequences(), [1]);
  assert.equal(record.descriptor.manifest.objectKey, `r/v1/${vault}/${snapshot}`);
  assert.equal(record.descriptor.manifest.versionId, `version-of-r/v1/${vault}/${snapshot}`);
  assert.ok(cloud.state.calls.includes('POST api/v1/backup/runs'));
});

test('a file comes back from Cloud storage, with no lease needed', async () => {
  const snapshot = first.service.view()!.snapshots[0]!.key;
  const listing = await first.service.browse({ snapshot, path: parts(at('server', 'documents', 'Tax')) });
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['Return 2025.xlsx']);
  await first.service.restore({ snapshot, items: [taxReturn()], into: at('server', 'restored') });
  const run = await finished(first.service);
  assert.equal(run.state, 'done', run.error ?? '');
  assert.equal(await readFile(at('server', 'restored', 'Return 2025.xlsx'), 'utf8'), 'the numbers '.repeat(4000));
  assert.ok(!cloud.state.calls.slice(cloud.state.calls.lastIndexOf('POST api/v1/backup/runs')).includes('POST api/v4/backup/lease'));
});

test('a backup Cloud could not record is kept and recorded before the next one starts', async () => {
  cloud.state.refuseSnapshots = 1;
  await writeFile(at('server', 'documents', 'notes.txt'), 'remember the milk and the eggs');
  await first.service.backUp();
  const failed = await finished(first.service);
  assert.deepEqual([failed.state, failed.error], ['failed', 'cloud_record_failed']);
  assert.deepEqual([sequences(), first.link.view().unrecorded], [[1], true]);
  await until(() => cloud.state.lease === null);

  await first.service.backUp();
  assert.equal((await finished(first.service)).state, 'done');
  assert.deepEqual([sequences(), first.link.view().unrecorded], [[1, 2, 3], false]);
  await until(() => cloud.state.lease === null);
});

test('one run holds the lease at a time, and losing it is noticed within a beat', async () => {
  cloud.state.heartbeatAfterSec = 1;
  let lost = false;
  const session = await first.link.begin('backup', vaultOf(key), () => (lost = true));
  await assert.rejects(first.link.begin('backup', vaultOf(key)), (error) => error instanceof CloudError && error.code === 'lease-held');
  cloud.state.lease = null;
  await until(() => lost);
  await session.end();
  cloud.state.heartbeatAfterSec = 60;
});

test('a run whose lease is lost is stopped at once, and the next run carries on', async () => {
  cloud.state.heartbeatAfterSec = 1;
  // Slow enough that the upload is still going when the lease goes.
  await writeFile(at('server', 'documents', 'big.bin'), randomBytes(400_000));
  first.service.setSettings({ ...DEFAULT_SETTINGS, folders: [at('server', 'documents')], limitMbps: 0.05 });
  await first.service.backUp();
  cloud.state.lease = null;
  const cut = await finished(first.service);
  assert.deepEqual([cut.state, cut.error], ['failed', 'cloud_lease_lost']);
  assert.deepEqual(sequences(), [1, 2, 3]);

  cloud.state.heartbeatAfterSec = 60;
  first.service.setSettings({ ...DEFAULT_SETTINGS, folders: [at('server', 'documents')] });
  await first.service.backUp();
  assert.equal((await finished(first.service)).state, 'done');
  assert.deepEqual(sequences(), [1, 2, 3, 4]);
  await until(() => cloud.state.lease === null);
});

test('a replacement server takes the backups over once the owner approves, with the saved recovery key', async () => {
  await link(second);
  const [older] = await second.link.takeoverCandidates();
  assert.equal(older?.name, machine.name);
  await second.link.askTakeover(older!.instanceId);
  assert.equal((await second.link.checkTakeover()).status, 'pending');
  cloud.approve();
  assert.equal((await second.link.checkTakeover()).status, 'approved');
  assert.equal(second.link.view().takeover, null);

  await assert.rejects(second.service.adoptKey('not a key'));
  await second.service.adoptKey(key);
  await assert.rejects(second.service.adoptKey(key), refused('server_backup_key_exists'));
  const snapshots = second.service.view()!.snapshots;
  assert.equal(snapshots.length, 4);
  await mkdir(at('server', 'replacement'));
  await second.service.restore({ snapshot: snapshots[0]!.key, items: [taxReturn()], into: at('server', 'replacement') });
  assert.equal((await finished(second.service)).state, 'done');
  assert.equal(await readFile(at('server', 'replacement', 'Return 2025.xlsx'), 'utf8'), 'the numbers '.repeat(4000));

  // The old installation is out.
  await assert.rejects(first.service.browse({ snapshot: snapshots[0]!.key, path: [] }), (error) => error instanceof CloudError && error.status === 401);

  // The replacement carries the same history on, under the older machine's id.
  await second.service.turnOn({ ...DEFAULT_SETTINGS, folders: [at('server', 'documents')] });
  await second.service.backUp();
  assert.equal((await finished(second.service)).state, 'done');
  assert.deepEqual(sequences(), [1, 2, 3, 4, 5]);
  assert.equal((cloud.state.chain[4]!.record as { descriptor: { instanceId: string } }).descriptor.instanceId, older!.instanceId);
  await until(() => cloud.state.lease === null);
});
