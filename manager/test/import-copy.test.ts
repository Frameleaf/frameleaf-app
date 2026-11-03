import { test, mock } from 'node:test';
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
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { ImportTransferJournal } from '../src/import-transfer-journal.js';
import { importPlanSha256 } from '../src/import-plan.js';
import { reviewedImport } from './import-plan-fixture.js';
import {
  closeImportCopyHandles,
  copyImportFiles,
  type ImportCopyRoot,
} from '../src/import-copy.js';

const linux = { skip: process.platform !== 'linux' };
for (const resume of [false, true]) {
  test(
    `refuses bind-mounted destination aliases before effects, resume=${resume}`,
    linux,
    async (t) => {
      const f = await fixture();
      const alias = join(f.directory, 'alias');
      let mounted = false;
      let store: Store | undefined;
      try {
        await mkdir(join(f.destination, 'sub'), { mode: 0o700 });
        await mkdir(alias, { mode: 0o700 });
        try {
          execFileSync('mount', ['--bind', join(f.destination, 'sub'), alias], {
            stdio: 'ignore',
          });
          mounted = true;
        } catch {
          t.skip('Requires bind-mount capability');
          return;
        }
        const identity = await stat(alias, { bigint: true });
        const roots = {
          ...f.roots,
          alias: {
            path: alias,
            device: String(identity.dev),
            inode: String(identity.ino),
          },
        };
        const original = f.journal.files(f.operation.id)[0].file;
        const first = {
          ...original,
          id: 'first',
          sourceAssetId: 'one',
          sourceFileId: 'shared',
          destinationPath: 'sub/photo.png',
        };
        const second = {
          ...first,
          id: 'second',
          sourceAssetId: 'two',
          destinationRoot: 'alias',
          destinationPath: 'photo.png',
        };
        const plan = {
          ...reviewedImport([]).plan,
          version: 2,
          roots: Object.entries(roots).map(([id, root]) => ({ id, ...root })),
          files: [first, second],
        };
        store = new Store(join(f.directory, 'alias-journal'));
        const { operation } = store.start('import', 'aliases', {});
        const journal = new ImportTransferJournal(store);
        journal.begin(operation.id, {
          manifestSha256: 'a'.repeat(64),
          planSha256: importPlanSha256(plan),
        });
        journal.sealPlan(operation.id, plan);
        journal.intent(operation.id, first);
        journal.intent(operation.id, second);
        if (resume) {
          await writeFile(join(f.destination, 'sub/photo.png'), f.bytes, {
            mode: 0o600,
          });
          journal.verified(operation.id, first.id, {
            sha256: first.sha256,
            bytes: first.bytes,
          });
        }
        await assert.rejects(
          copyImportFiles(journal, operation.id, roots, resume),
          /import_destination_alias/,
        );
        assert.deepEqual(await readFile(join(f.source, 'photo.png')), f.bytes);
        assert.deepEqual(
          journal.files(operation.id).map(({ state }) => state),
          [resume ? 'verified' : 'intent', 'intent'],
        );
        if (resume)
          assert.deepEqual(await readFile(join(alias, 'photo.png')), f.bytes);
        else
          await assert.rejects(stat(join(alias, 'photo.png')), {
            code: 'ENOENT',
          });
      } finally {
        store?.close();
        f.store.close();
        if (mounted) execFileSync('umount', [alias]);
        await rm(f.directory, { recursive: true, force: true });
      }
    },
  );
}
test(
  'shared originals resume into separate verified copies after acknowledgement loss',
  linux,
  async () => {
    const f = await fixture();
    let store = new Store(join(f.directory, 'shared-journal'));
    try {
      const { operation } = store.start('import', 'shared-original', {});
      const original = f.journal.files(f.operation.id)[0].file;
      const first = {
        ...original,
        id: 'placement-one',
        sourceAssetId: 'photo-one',
        sourceFileId: 'shared-file',
      };
      const second = {
        ...first,
        id: 'placement-two',
        sourceAssetId: 'photo-two',
        destinationPath: 'second.png',
      };
      const plan = {
        ...reviewedImport([]).plan,
        version: 2,
        roots: Object.entries(f.roots).map(([id, root]) => ({ id, ...root })),
        files: [first, second],
      };
      const binding = {
        manifestSha256: 'a'.repeat(64),
        planSha256: importPlanSha256(plan),
      };
      let journal = new ImportTransferJournal(store);
      journal.begin(operation.id, binding);
      journal.sealPlan(operation.id, plan);
      journal.intent(operation.id, first);
      journal.intent(operation.id, second);
      const acknowledge = journal.verified.bind(journal);
      const interrupted = mock.method(
        journal,
        'verified',
        (...args: Parameters<typeof acknowledge>) => {
          acknowledge(...args);
          throw new Error('synthetic acknowledgement loss');
        },
      );
      await assert.rejects(
        copyImportFiles(journal, operation.id, f.roots, false),
      );
      interrupted.mock.restore();
      assert.deepEqual(
        journal.files(operation.id).map(({ state }) => state),
        ['verified', 'intent'],
      );
      store.close();
      store = new Store(join(f.directory, 'shared-journal'));
      store.interrupt();
      journal = new ImportTransferJournal(store);
      assert.deepEqual(
        await copyImportFiles(journal, operation.id, f.roots, true),
        { files: 2, bytes: String(f.bytes.length * 2) },
      );
      const paths = [
        join(f.source, 'photo.png'),
        join(f.destination, 'photo.png'),
        join(f.destination, 'second.png'),
      ];
      for (const path of paths) assert.deepEqual(await readFile(path), f.bytes);
      assert.equal(
        new Set(
          await Promise.all(
            paths.map(async (path) =>
              String((await stat(path, { bigint: true })).ino),
            ),
          ),
        ).size,
        3,
      );
      assert.deepEqual(
        journal.files(operation.id).map(({ state }) => state),
        ['verified', 'verified'],
      );
    } finally {
      store.close();
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
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
