import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  symlink,
  link,
  unlink,
  open,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { adoptImportFiles } from '../src/import-adoption.js';
import { Store } from '../src/store.js';
import { ImportTransferJournal } from '../src/import-transfer-journal.js';
import { reviewedImport } from './import-plan-fixture.js';

const linux = { skip: process.platform !== 'linux' };
async function fixture(
  options: {
    hardlink?: boolean;
    hash?: string;
    nested?: boolean;
    differentEntry?: boolean;
    empty?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'import-adoption-'));
  const media = join(directory, 'media');
  await mkdir(media, { mode: 0o700 });
  await mkdir(join(media, 'camera'), { mode: 0o700 });
  const path = join(media, 'camera', 'photo.jpg');
  const bytes = Buffer.from('synthetic-adopted-original');
  await writeFile(path, bytes, { mode: 0o640 });
  if (options.differentEntry)
    await writeFile(join(media, 'camera/other.jpg'), bytes);
  if (options.hardlink) await link(path, join(directory, 'outside.jpg'));
  const identity = await stat(path, { bigint: true });
  const rootPaths = options.nested
    ? { media, camera: join(media, 'camera') }
    : { media };
  const roots: Record<string, { path: string; device: string; inode: string }> =
    {};
  for (const [id, path] of Object.entries(rootPaths)) {
    const entry = await stat(path, { bigint: true });
    roots[id] = { path, device: String(entry.dev), inode: String(entry.ino) };
  }
  const file = {
    id: 'original',
    mode: 'adopt' as const,
    sourceRoot: 'media',
    destinationRoot: options.nested ? 'camera' : 'media',
    sourcePath: 'camera/photo.jpg',
    destinationPath: options.differentEntry
      ? 'camera/other.jpg'
      : options.nested
        ? 'photo.jpg'
        : 'camera/photo.jpg',
    bytes: String(identity.size),
    sha256: options.hash ?? createHash('sha256').update(bytes).digest('hex'),
    destinationDevice: String(identity.dev),
    sourceIdentity: {
      device: String(identity.dev),
      inode: String(identity.ino),
      bytes: String(identity.size),
      mtimeNs: String(identity.mtimeNs),
      ctimeNs: String(identity.ctimeNs),
      links: String(identity.nlink),
    },
  };
  const review = reviewedImport(
    options.empty ? [] : [file],
    Object.entries(roots).map(([id, root]) => ({ id, ...root })),
  );
  const store = new Store(join(directory, 'journal'));
  const operation = store.start('import', 'synthetic-adoption', {}).operation;
  const journal = new ImportTransferJournal(store);
  journal.begin(operation.id, review.binding);
  journal.sealPlan(operation.id, review.plan);
  if (!options.empty) journal.intent(operation.id, file);
  return {
    directory,
    media,
    path,
    bytes,
    identity,
    roots,
    file,
    store,
    journal,
    operation,
    review,
    close: async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const nested of [false, true]) {
  test(
    'adopts the same original without changing media, nested roots=' + nested,
    linux,
    async () => {
      const f = await fixture({ nested });
      try {
        assert.deepEqual(
          await adoptImportFiles(f.journal, f.operation.id, f.roots),
          { files: 1, bytes: String(f.bytes.length) },
        );
        assert.equal(f.journal.files(f.operation.id)[0].state, 'verified');
        assert.deepEqual(await readFile(f.path), f.bytes);
        for (const field of [
          'dev',
          'ino',
          'mode',
          'uid',
          'gid',
          'size',
          'mtimeNs',
          'ctimeNs',
          'nlink',
        ] as const)
          assert.equal(
            (await stat(f.path, { bigint: true }))[field],
            f.identity[field],
          );
        assert.deepEqual(
          await adoptImportFiles(f.journal, f.operation.id, f.roots),
          { files: 1, bytes: String(f.bytes.length) },
        );
      } finally {
        await f.close();
      }
    },
  );
}

test(
  'rehashes verified adoption receipts and refuses changed originals',
  linux,
  async () => {
    const f = await fixture();
    try {
      await adoptImportFiles(f.journal, f.operation.id, f.roots);
      await writeFile(f.path, 'changed original');
      await assert.rejects(
        adoptImportFiles(f.journal, f.operation.id, f.roots),
        /import_adoption_source_changed/,
      );
      assert.equal(f.journal.files(f.operation.id)[0].state, 'verified');
      assert.equal(await readFile(f.path, 'utf8'), 'changed original');
    } finally {
      await f.close();
    }
  },
);

test(
  'recovers an interruption between checking bytes and recording completion',
  linux,
  async () => {
    const f = await fixture();
    try {
      const receipt = mock.method(f.journal, 'verified', () => {
        throw new Error('synthetic receipt interruption');
      });
      await assert.rejects(
        adoptImportFiles(f.journal, f.operation.id, f.roots),
        /import_adoption_unavailable/,
      );
      assert.equal(f.journal.files(f.operation.id)[0].state, 'intent');
      assert.deepEqual(await readFile(f.path), f.bytes);
      receipt.mock.restore();
      await adoptImportFiles(f.journal, f.operation.id, f.roots);
      assert.equal(f.journal.files(f.operation.id)[0].state, 'verified');
    } finally {
      await f.close();
    }
  },
);

for (const problem of [
  'checksum',
  'hardlink',
  'symlink',
  'parent-symlink',
  'missing',
  'fifo',
  'root',
  'different-file',
] as const) {
  test(
    'refuses unsafe adoption without changing media: ' + problem,
    linux,
    async () => {
      const f = await fixture({
        hardlink: problem === 'hardlink',
        hash: problem === 'checksum' ? '0'.repeat(64) : undefined,
      });
      try {
        const original = join(f.directory, 'retained.jpg');
        if (problem === 'symlink') {
          await writeFile(original, f.bytes);
          await unlink(f.path);
          await symlink(original, f.path);
        } else if (problem === 'parent-symlink') {
          const parent = join(f.directory, 'camera');
          await mkdir(parent);
          await writeFile(join(parent, 'photo.jpg'), f.bytes);
          await rm(join(f.media, 'camera'), { recursive: true });
          await symlink(parent, join(f.media, 'camera'));
        } else if (problem === 'missing') await unlink(f.path);
        else if (problem === 'fifo') {
          await unlink(f.path);
          execFileSync('mkfifo', [f.path]);
        } else if (problem === 'root')
          f.roots.media.inode = String(BigInt(f.roots.media.inode) + 1n);
        else if (problem === 'different-file') {
          const replacement = join(f.directory, 'different-media');
          await mkdir(join(replacement, 'camera'), { recursive: true });
          await writeFile(join(replacement, 'camera/photo.jpg'), f.bytes);
          const root = await stat(replacement, { bigint: true });
          f.roots.media = {
            path: replacement,
            device: String(root.dev),
            inode: String(root.ino),
          };
        }
        await assert.rejects(
          adoptImportFiles(f.journal, f.operation.id, f.roots),
          /import_/,
        );
        assert.equal(f.journal.files(f.operation.id)[0].state, 'intent');
        if (!['missing', 'fifo'].includes(problem))
          assert.deepEqual(await readFile(f.path), f.bytes);
      } finally {
        await f.close();
      }
    },
  );
}

test(
  'refuses adoption after abandoning the operation while retaining originals and recovery records',
  linux,
  async () => {
    const f = await fixture();
    try {
      f.journal.abandon(f.operation.id);
      await assert.rejects(
        adoptImportFiles(f.journal, f.operation.id, f.roots),
      );
      assert.deepEqual(await readFile(f.path), f.bytes);
      assert.equal(f.journal.files(f.operation.id).length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'requires a sealed reviewed plan before adopting originals',
  linux,
  async () => {
    const f = await fixture();
    try {
      mock.method(f.journal, 'review', () => ({
        plan: null,
        verification: null,
      }));
      await assert.rejects(
        adoptImportFiles(f.journal, f.operation.id, f.roots),
        /import_adoption_plan_required/,
      );
      assert.deepEqual(await readFile(f.path), f.bytes);
      assert.equal(f.journal.files(f.operation.id)[0].state, 'intent');
    } finally {
      await f.close();
    }
  },
);

test(
  'refuses a separate directory entry even when its bytes match',
  linux,
  async () => {
    const f = await fixture({ differentEntry: true });
    try {
      await assert.rejects(
        adoptImportFiles(f.journal, f.operation.id, f.roots),
        /import_adoption_layout_changed/,
      );
      assert.deepEqual(await readFile(f.path), f.bytes);
      assert.deepEqual(
        await readFile(join(f.media, 'camera/other.jpg')),
        f.bytes,
      );
      assert.equal(f.journal.files(f.operation.id)[0].state, 'intent');
    } finally {
      await f.close();
    }
  },
);
test(
  'recovers all sealed plan entries when no transfer intent was committed yet',
  linux,
  async () => {
    const f = await fixture();
    try {
      f.store.db
        .prepare('DELETE FROM library_import_transfers WHERE operation_id=?')
        .run(f.operation.id);
      assert.deepEqual(
        await adoptImportFiles(f.journal, f.operation.id, f.roots),
        { files: 1, bytes: String(f.bytes.length) },
      );
      assert.equal(f.journal.files(f.operation.id)[0].state, 'verified');
    } finally {
      await f.close();
    }
  },
);
test(
  'refuses simple adoption recovery once destination writers have been armed',
  linux,
  async () => {
    const f = await fixture();
    try {
      await adoptImportFiles(f.journal, f.operation.id, f.roots);
      f.journal.recordVerification(f.operation.id, f.review.verification);
      f.journal.writersStarting(f.operation.id);
      await assert.rejects(
        adoptImportFiles(f.journal, f.operation.id, f.roots),
        /import_post_activation_recovery_required/,
      );
      assert.deepEqual(await readFile(f.path), f.bytes);
      assert.equal(f.journal.files(f.operation.id)[0].state, 'verified');
    } finally {
      await f.close();
    }
  },
);

test(
  'retains intent if original durability cannot be established',
  linux,
  async () => {
    const f = await fixture();
    const handle = await open(f.path, 'r');
    const sync = mock.method(
      Object.getPrototypeOf(handle),
      'sync',
      async () => {
        throw new Error('synthetic fsync failure');
      },
    );
    try {
      await assert.rejects(
        adoptImportFiles(f.journal, f.operation.id, f.roots),
        /import_adoption_unavailable/,
      );
      assert.equal(f.journal.files(f.operation.id)[0].state, 'intent');
    } finally {
      sync.mock.restore();
      await handle.close();
      await f.close();
    }
  },
);

for (const boundary of [
  'abandoned',
  'writers-starting',
  'completed',
] as const) {
  test(
    'enforces an empty plan operation boundary: ' + boundary,
    linux,
    async () => {
      const f = await fixture({ empty: true });
      try {
        if (boundary === 'abandoned') f.journal.abandon(f.operation.id);
        else if (boundary === 'writers-starting') {
          f.journal.recordVerification(f.operation.id, f.review.verification);
          f.journal.writersStarting(f.operation.id);
        } else {
          f.operation.state = 'complete';
          f.store.save(f.operation);
        }
        await assert.rejects(
          adoptImportFiles(f.journal, f.operation.id, f.roots),
        );
        assert.deepEqual(await readFile(f.path), f.bytes);
      } finally {
        await f.close();
      }
    },
  );
}

test(
  'accepts an empty reviewed plan while its operation remains owned and inactive',
  linux,
  async () => {
    const f = await fixture({ empty: true });
    try {
      assert.deepEqual(
        await adoptImportFiles(f.journal, f.operation.id, f.roots),
        { files: 0, bytes: '0' },
      );
      assert.deepEqual(f.journal.files(f.operation.id), []);
      assert.deepEqual(await readFile(f.path), f.bytes);
    } finally {
      await f.close();
    }
  },
);
