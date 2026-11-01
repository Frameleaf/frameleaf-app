import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  symlink,
  link,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { ImportTransferJournal } from '../src/import-transfer-journal.js';
import {
  closeImportCopyHandles,
  copyImportFiles,
  type ImportCopyRoot,
} from '../src/import-copy.js';

const linux = { skip: process.platform !== 'linux' };
test('cleanup attempts all handles after a close failure', async () => {
  const closed: number[] = [];
  await assert.rejects(
    closeImportCopyHandles(
      [0, 1, 2].map((id) => ({
        close: () => {
          closed.push(id);
          if (id === 0) throw new Error('injected close failure');
          return Promise.resolve();
        },
      })),
    ),
    /import_copy_cleanup_failed/,
  );
  assert.deepEqual(closed, [0, 1, 2]);
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'import-copy-'));
  const source = join(directory, 'source'),
    destination = join(directory, 'destination');
  await mkdir(source, { mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  const bytes = Buffer.from('synthetic-original-content');
  await writeFile(join(source, 'photo.png'), bytes);
  const store = new Store(join(directory, 'journal'));
  const operation = store.start('import', 'request', {}).operation;
  const journal = new ImportTransferJournal(store);
  journal.begin(operation.id, {
    manifestSha256: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
  });

  const identity = await stat(join(source, 'photo.png'), { bigint: true });
  journal.intent(operation.id, {
    id: 'photo',
    mode: 'copy',
    sourceRoot: 'source',
    destinationRoot: 'destination',
    sourcePath: 'photo.png',
    destinationPath: 'photo.png',
    bytes: String(bytes.length),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    destinationDevice: String((await stat(destination, { bigint: true })).dev),
    sourceIdentity: {
      device: String(identity.dev),
      inode: String(identity.ino),
      bytes: String(identity.size),
      mtimeNs: String(identity.mtimeNs),
      ctimeNs: String(identity.ctimeNs),
      links: String(identity.nlink),
    },
  });
  const roots: Record<string, ImportCopyRoot> = {};
  for (const [key, path] of Object.entries({ source, destination })) {
    const s = await stat(path, { bigint: true });
    roots[key] = { path, device: String(s.dev), inode: String(s.ino) };
  }
  return {
    directory,
    source,
    destination,
    bytes,
    store,
    journal,
    operation,
    roots,
  };
}
test(
  'copies independent original bytes and records verified completion',
  linux,
  async () => {
    const f = await fixture();
    try {
      await copyImportFiles(f.journal, f.operation.id, f.roots, false);
      assert.deepEqual(
        await readFile(join(f.destination, 'photo.png')),
        f.bytes,
      );
      assert.deepEqual(await readFile(join(f.source, 'photo.png')), f.bytes);
      assert.notEqual(
        (await stat(join(f.source, 'photo.png'))).ino,
        (await stat(join(f.destination, 'photo.png'))).ino,
      );
      assert.equal(f.journal.files(f.operation.id)[0].state, 'verified');
    } finally {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
test(
  'resumes a verified prefix after journal restart without overwriting existing bytes',
  linux,
  async () => {
    const f = await fixture();
    try {
      await writeFile(
        join(f.destination, 'photo.png'),
        f.bytes.subarray(0, 9),
        { mode: 0o600 },
      );
      f.store.close();
      f.store = new Store(join(f.directory, 'journal'));
      f.store.interrupt();
      f.journal = new ImportTransferJournal(f.store);
      await copyImportFiles(f.journal, f.operation.id, f.roots, true);
      assert.deepEqual(
        await readFile(join(f.destination, 'photo.png')),
        f.bytes,
      );
      assert.equal(f.journal.files(f.operation.id)[0].state, 'verified');
    } finally {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
test(
  'refuses fresh collisions, mismatching resume bytes and symlinks while retaining originals',
  linux,
  async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.destination, 'photo.png'), 'unrelated', {
        mode: 0o600,
      });
      await assert.rejects(
        copyImportFiles(f.journal, f.operation.id, f.roots, false),
        /import_copy_collision/,
      );
      await assert.rejects(
        copyImportFiles(f.journal, f.operation.id, f.roots, true),
        /import_copy_prefix_changed/,
      );
      assert.equal(
        await readFile(join(f.destination, 'photo.png'), 'utf8'),
        'unrelated',
      );
      await rm(join(f.destination, 'photo.png'));
      await symlink(
        join(f.source, 'photo.png'),
        join(f.destination, 'photo.png'),
      );
      await assert.rejects(
        copyImportFiles(f.journal, f.operation.id, f.roots, true),
        /import_copy_unavailable/,
      );
      assert.deepEqual(await readFile(join(f.source, 'photo.png')), f.bytes);
      assert.equal(f.journal.files(f.operation.id)[0].state, 'intent');
    } finally {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test(
  'refuses changed source, root identity and destination hardlinks before recording verification',
  linux,
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        copyImportFiles(
          f.journal,
          f.operation.id,
          {
            ...f.roots,
            destination: { ...f.roots.destination, inode: '999' },
          },
          false,
        ),
        /import_copy_root_changed/,
      );
      await chmod(f.destination, 0o755);
      await assert.rejects(
        copyImportFiles(f.journal, f.operation.id, f.roots, false),
        /import_copy_root_changed/,
      );
      await chmod(f.destination, 0o700);
      await writeFile(join(f.directory, 'unrelated'), f.bytes, {
        mode: 0o600,
      });
      await link(
        join(f.directory, 'unrelated'),
        join(f.destination, 'photo.png'),
      );
      await assert.rejects(
        copyImportFiles(f.journal, f.operation.id, f.roots, true),
        /import_copy_destination_changed/,
      );
      await rm(join(f.destination, 'photo.png'));
      await writeFile(join(f.source, 'photo.png'), 'changed source');
      await assert.rejects(
        copyImportFiles(f.journal, f.operation.id, f.roots, false),
        /import_copy_source_changed/,
      );
      assert.equal(f.journal.files(f.operation.id)[0].state, 'intent');
      assert.deepEqual(await readFile(join(f.directory, 'unrelated')), f.bytes);
    } finally {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
