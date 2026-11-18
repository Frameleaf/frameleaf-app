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
  assert.equal(run.outcome.files, 4);
  assert.equal(run.outcome.problems, 0);

  const view = service.view()!;
  assert.equal(view.snapshots.length, 1);
  assert.equal(view.last?.state, 'done');
  assert.deepEqual(view.folders.map((folder) => [folder.kind, folder.files]), [['manager', 1], ['folder', 2], ['folder', 1]]);

  const stored = (await readdir(at('repository'), { recursive: true })).join('\n');
  assert.doesNotMatch(stored, /Return|notes|documents|settings/);
});

test('a second backup of unchanged folders stores nothing new', async () => {
  await service.backUp();
  const run = await finished();
  assert.ok(run.outcome?.kind === 'backup');
  assert.equal(run.outcome.storedBytes, 0);
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
  assert.deepEqual(folders!.map((folder) => [folder.path, folder.kind, folder.reachable]).sort(), [
    [at('server', 'appdata'), 'folder', true],
    [at('server', 'documents'), 'folder', true],
    [at('server', 'recovery'), 'manager', true],
  ]);
  assert.ok(folders!.every((folder) => folder.files > 0 && folder.bytes > 0));
  // The record is not something to restore, so the browser does not show it.
  const top = await service.browse({ snapshot, path: [] });
  assert.ok(!top.entries.some((entry) => entry.name.startsWith('.frameleaf')));
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
  assert.equal(service.view()!.snapshots.length, 3);
});
