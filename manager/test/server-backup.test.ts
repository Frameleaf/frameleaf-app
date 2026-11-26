import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test, { after, before } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_SETTINGS, ServerBackup, type Run } from '../src/server-backup.js';
import { skips } from '../src/server-backup-worker.js';
import { Store } from '../src/store.js';

let root: string;
let store: Store;
let service: ServerBackup;
const at = (...names: string[]) => join(root, ...names);
const parts = (path: string) => path.split(sep).filter(Boolean);
const settings = () => ({ ...DEFAULT_SETTINGS, folders: [at('server', 'documents'), at('server', 'appdata')] });
const make = (target = true) =>
  new ServerBackup(store, {
    target: target ? { kind: 'folder', path: at('repository') } : null,
    inside: (path) => path === at('server') || path.startsWith(at('server') + sep),
    always: [at('server', 'recovery')],
    managerState: at('server', 'manager-state'),
    photoKeys: () => at('server', 'photos', 'frameleaf', 'identity'),
  });

/** Waits for the run in flight and returns how it ended. */
async function finished(): Promise<Run> {
  for (let tries = 0; tries < 1500; tries++) {
    if (!service.view()?.running) return service.runs(1)[0]!;
    await sleep(20);
  }
  throw new Error('The run did not finish');
}
const refused = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'manager-server-backup-')));
  await mkdir(at('server', 'documents', 'Tax'), { recursive: true });
  await mkdir(at('server', 'documents', 'cache'));
  await mkdir(at('server', 'appdata'));
  await mkdir(at('server', 'recovery'));
  await mkdir(at('server', 'photos', 'frameleaf', 'identity', 'cloud-backup-scratch'), { recursive: true });
  await writeFile(at('server', 'photos', 'frameleaf', 'identity', 'backup-key-1.pem'), 'the photo library key');
  await writeFile(at('server', 'photos', 'frameleaf', 'identity', 'cloud-backup-scratch', 'big.tmp'), 'rebuilt');
  await writeFile(at('server', 'photos', 'holiday.jpg'), 'a photo');
  await writeFile(at('server', 'documents', 'Tax', 'Return 2025.xlsx'), 'the numbers '.repeat(4000));
  await writeFile(at('server', 'documents', 'notes.txt'), 'remember the milk');
  await writeFile(at('server', 'documents', 'draft.tmp'), 'throwaway');
  await writeFile(at('server', 'documents', 'cache', 'thumb.bin'), 'rebuilt by the app');
  await writeFile(at('server', 'appdata', 'settings.json'), '{"theme":"dark"}');
  await writeFile(at('server', 'recovery', 'point'), 'database recovery point');
  store = new Store(at('state'));
  service = make();
});
after(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

test('patterns leave out files and folders by name', () => {
  const skip = skips(['*.tmp', 'cache/', '.Trash-*/']);
  assert.equal(skip('draft.tmp', false), true);
  assert.equal(skip('draft.tmp.txt', false), false);
  assert.equal(skip('cache', true), true);
  assert.equal(skip('cache', false), false);
  assert.equal(skip('.Trash-1000', true), true);
  assert.equal(skip('a+b(1).tmp', false), true);
});

test('Server Backup stays hidden until this Manager has somewhere to back up to', () => {
  assert.equal(make(false).view(), null);
  assert.equal(service.view()?.state, 'off');
});

test('turning it on needs folders Manager can read, none inside another', async () => {
  await assert.rejects(service.turnOn({ ...settings(), folders: [] }), refused('server_backup_no_folders'));
  await assert.rejects(service.turnOn({ ...settings(), folders: ['/etc'] }), refused('server_backup_folder_outside'));
  await assert.rejects(
    service.turnOn({ ...settings(), folders: [at('server', 'documents'), at('server', 'documents', 'Tax')] }),
    refused('server_backup_folders_overlap'),
  );
  await assert.rejects(service.turnOn({ ...settings(), folders: [at('server')] }), refused('server_backup_folders_overlap'));
  await assert.rejects(service.backUp(), refused('server_backup_off'));
  await service.turnOn(settings());
  assert.equal(service.view()?.state, 'on');
  assert.equal((await readFile(at('state', 'server-backup.key'), 'utf8')).length, 64);
});

test('a backup protects the chosen folders and Manager’s recovery points, and stores no names', async () => {
  await service.backUp();
  await assert.rejects(service.backUp(), refused('server_backup_busy'));
  const run = await finished();
  assert.equal(run.state, 'done');
  assert.ok(run.outcome?.kind === 'backup');
  // Return, notes, settings and the recovery point; the .tmp file and the cache folder are left out.
  // Also Manager's settings copy and the photo library's key (not its scratch space).
  assert.equal(run.outcome.files, 6);
  assert.equal(run.outcome.problems, 0);

  const view = service.view()!;
  assert.equal(view.snapshots.length, 1);
  assert.equal(view.last?.state, 'done');
  assert.deepEqual(view.folders.map((folder) => [folder.kind, folder.files]), [['manager', 1], ['manager', 1], ['manager', 1], ['folder', 2], ['folder', 1]]);

  const stored = (await readdir(at('repository'), { recursive: true })).join('\n');
  assert.doesNotMatch(stored, /Return|notes|documents|settings/);
});

test('a second backup of unchanged folders stores nothing new', async () => {
  await service.backUp();
  const run = await finished();
  assert.ok(run.outcome?.kind === 'backup');
  // Only Manager's own settings copy changed (it records each run); none of the folders is stored again.
  assert.ok(run.outcome.storedBytes < 16 * 1024, String(run.outcome.storedBytes));
  assert.equal(service.view()!.snapshots.length, 2);
});

test('a backup can be browsed by folder, and a file put back where it was or somewhere else', async () => {
  const snapshot = service.view()!.snapshots[0]!.key;
  const documents = parts(at('server', 'documents'));
  const listed = await service.browse({ snapshot, path: documents });
  assert.deepEqual(listed.entries.map((entry) => [entry.name, entry.type]), [['Tax', 'folder'], ['notes.txt', 'file']]);
  await assert.rejects(service.browse({ snapshot, path: ['nowhere'] }), refused('server_backup_no_such_folder'));

  // Somewhere else: the original is untouched.
  await mkdir(at('server', 'restored'));
  await service.restore({ snapshot, items: [[...documents, 'Tax']], into: at('server', 'restored') });
  assert.equal((await finished()).state, 'done');
  assert.equal(await readFile(at('server', 'restored', 'Tax', 'Return 2025.xlsx'), 'utf8'), 'the numbers '.repeat(4000));

  // Back where it was: the newer file in the way is kept under another name.
  await writeFile(at('server', 'documents', 'notes.txt'), 'newer words');
  await service.restore({ snapshot, items: [[...documents, 'notes.txt']], into: null });
  const run = await finished();
  assert.ok(run.outcome?.kind === 'restore');
  assert.equal(run.outcome.movedAside, 1);
  assert.equal(await readFile(at('server', 'documents', 'notes.txt'), 'utf8'), 'remember the milk');
  const kept = (await readdir(at('server', 'documents'))).find((name) => name.startsWith('notes.txt.before-restore-'));
  assert.equal(await readFile(at('server', 'documents', kept!), 'utf8'), 'newer words');

  await assert.rejects(service.restore({ snapshot, items: [[...documents, 'notes.txt']], into: '/etc' }), refused('server_backup_folder_outside'));
  await assert.rejects(service.restore({ snapshot, items: [['etc', 'passwd']], into: null }), refused('server_backup_folder_outside'));
});

test('a backup records what it protected, for a server that replaces this one', async () => {
  const snapshot = service.view()!.snapshots[0]!.key;
  const { folders } = await service.contents({ snapshot });
  assert.deepEqual(folders!.map((folder) => [folder.path, folder.kind, folder.role, folder.reachable]).sort(), [
    [at('server', 'appdata'), 'folder', undefined, true],
    [at('server', 'documents'), 'folder', undefined, true],
    [at('server', 'manager-state'), 'manager', 'manager', true],
    [at('server', 'photos', 'frameleaf', 'identity'), 'manager', 'photo-key', true],
    [at('server', 'recovery'), 'manager', 'recovery', true],
  ]);
  // Manager's own settings went in as a consistent copy of its database, and the photo library's keys without their scratch space.
  const keys = parts(at('server', 'photos', 'frameleaf', 'identity'));
  assert.deepEqual((await service.browse({ snapshot, path: keys })).entries.map((entry) => entry.name), ['backup-key-1.pem']);
  const state = (await service.browse({ snapshot, path: parts(at('server', 'manager-state')) })).entries;
  assert.deepEqual(state.map((entry) => entry.name), ['manager.sqlite']);
  assert.ok(state[0]!.bytes > 0);
  assert.ok(folders!.every((folder) => folder.files > 0 && folder.bytes > 0));
  // The record is not something to restore, so the browser does not show it.
  const top = await service.browse({ snapshot, path: [] });
  assert.ok(!top.entries.some((entry) => entry.name.startsWith('.frameleaf')));
});

test('choosing the whole photo library protects its keys there, not twice; a folder inside Manager’s own is refused', async () => {
  const keys = at('server', 'photos', 'frameleaf', 'identity');
  await assert.rejects(Promise.resolve().then(() => service.setSettings({ ...settings(), folders: [keys] })), refused('server_backup_folders_overlap'));
  service.setSettings({ ...settings(), folders: [...settings().folders, at('server', 'photos')] });
  const view = service.view()!;
  assert.ok(!view.folders.some((folder: { path: string }) => folder.path === keys));
  assert.ok(view.folders.some((folder: { path: string; kind: string }) => folder.path === at('server', 'photos') && folder.kind === 'folder'));
  service.setSettings(settings());
  assert.ok(service.view()!.folders.some((folder: { path: string }) => folder.path === keys));
});

test('a replacement Manager picks up the old one’s backup settings from the restored copy, and only those', async () => {
  // The copy every backup took of this Manager's database stands in for one a whole-server restore brought back.
  service.setSettings({ ...settings(), schedule: { time: '03:30', stop: null }, folders: [...settings().folders, at('server', 'gone')] });
  await mkdir(at('server', 'gone'));
  await service.backUp();
  await finished();
  await rm(at('server', 'gone'), { recursive: true });
  // This Manager has backed up: the copy is its own, and nothing is offered.
  assert.equal(service.restoredSettings(), null);

  const fresh = new Store(at('fresh-state'));
  const replacement = new ServerBackup(fresh, {
    target: { kind: 'folder', path: at('repository') },
    inside: (path) => path === at('server') || path.startsWith(at('server') + sep),
    always: [at('server', 'recovery')],
    managerState: at('server', 'manager-state'),
  });
  fresh.set('administrator', { name: 'new owner' });
  const offered = replacement.restoredSettings()!;
  assert.equal(offered.settings.schedule.time, '03:30');
  assert.deepEqual(offered.folders.find((folder) => folder.path === at('server', 'gone'))?.reachable, false);
  const { skipped } = await replacement.applyRestoredSettings();
  assert.deepEqual(skipped, [at('server', 'gone')]);
  const view = replacement.view()!;
  assert.deepEqual([view.state, view.settings.schedule.time, view.settings.folders], ['on', '03:30', settings().folders]);
  // Nothing else of the old Manager came across.
  assert.deepEqual(fresh.get('administrator'), { name: 'new owner' });
  fresh.close();
  service.setSettings(settings());
});

test('the schedule keeps the owner’s time zone, not the container’s', async () => {
  const zoned = new ServerBackup(new Store(at('zoned-state')), {
    target: { kind: 'folder', path: at('zoned-repository') },
    inside: (path) => path === at('server') || path.startsWith(at('server') + sep),
    always: [],
  });
  await zoned.turnOn({ ...settings(), schedule: { time: '02:00', stop: null }, timeZone: 'Asia/Tokyo' });
  // 02:00 in Tokyo (UTC+9, no daylight time) is 17:00 UTC the day before. 02:00 UTC is 11:00 there: nothing starts.
  await zoned.tick(new Date('2026-11-17T16:00:00Z'));
  await zoned.tick(new Date('2026-11-18T02:00:00Z'));
  assert.equal(zoned.view()!.running, null);
  assert.equal(zoned.view(new Date('2026-11-18T03:00:00Z'))!.next, Date.parse('2026-11-18T17:00:00Z'));
  await zoned.tick(new Date('2026-11-18T17:00:00Z'));
  assert.equal(zoned.view()!.running?.trigger, 'schedule');
  zoned.stop();
  await assert.rejects(Promise.resolve().then(() => zoned.setSettings({ ...settings(), timeZone: 'Not/AZone' })));
});

test('a scheduled minute the timer skipped still starts that day’s backup', async () => {
  const skipped = new ServerBackup(new Store(at('skipped-state')), {
    target: { kind: 'folder', path: at('skipped-repository') },
    inside: (path) => path === at('server') || path.startsWith(at('server') + sep),
    always: [],
  });
  await skipped.turnOn({ ...settings(), schedule: { time: '02:00', stop: null } });
  await skipped.tick(new Date(2026, 10, 19, 1, 59, 59));
  assert.equal(skipped.view()!.running, null);
  await skipped.tick(new Date(2026, 10, 19, 2, 1, 0));
  assert.equal(skipped.view()!.running?.trigger, 'schedule');
  skipped.stop();
});

test('a backup missed while Manager was not running is caught up when it starts, inside its window', async () => {
  const late = (name: string) =>
    new ServerBackup(new Store(at(`${name}-state`)), {
      target: { kind: 'folder', path: at(`${name}-repository`) },
      inside: (path) => path === at('server') || path.startsWith(at('server') + sep),
      always: [],
    });
  const caught = late('caught');
  await caught.turnOn({ ...settings(), schedule: { time: '02:00', stop: '06:00' } });
  await caught.tick(new Date(2026, 10, 19, 5, 0, 0));
  assert.equal(caught.view()!.running?.trigger, 'schedule');
  caught.stop();
  // After the window closed, the next day's run is the next one.
  const closed = late('closed');
  await closed.turnOn({ ...settings(), schedule: { time: '02:00', stop: '06:00' } });
  await closed.tick(new Date(2026, 10, 19, 7, 0, 0));
  assert.equal(closed.view()!.running, null);
  // Only when Manager starts: a running Manager that passed the time already decided.
  await closed.tick(new Date(2026, 10, 19, 7, 1, 0));
  assert.equal(closed.view()!.running, null);
});

test('the schedule starts one backup a day at its time', async () => {
  const two = new Date(2026, 10, 18, 2, 0, 30);
  await service.tick(new Date(2026, 10, 18, 1, 59, 0));
  assert.equal(service.view()!.running, null);
  await service.tick(two);
  assert.equal(service.view()!.running?.trigger, 'schedule');
  assert.equal((await finished()).state, 'done');
  await service.tick(two);
  assert.equal(service.view()!.running, null);
  assert.equal(new Date(service.view(two)!.next!).getDate(), 19);
});

test('a run cut short by a restart is recorded as stopped, and turning off keeps what is stored', async () => {
  store.db.prepare('INSERT INTO server_backup_runs (value) VALUES (?)').run(
    JSON.stringify({ kind: 'backup', trigger: 'you', state: 'running', startedAt: 1, finishedAt: null, progress: null, outcome: null, error: null }),
  );
  service = make();
  assert.deepEqual([service.runs(1)[0]!.state, service.runs(1)[0]!.error], ['stopped', 'manager_restarted']);
  service.turnOff();
  assert.equal(service.view()!.state, 'off');
  assert.equal(service.view()!.snapshots.length, 4);
});
