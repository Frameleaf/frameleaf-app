import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  link,
  symlink,
  rename,
  chmod,
} from 'node:fs/promises';
import type { ImportCopyRoot } from '../src/import-copy.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { ImportTransferJournal } from '../src/import-transfer-journal.js';
import {
  relocateImportFiles,
  rollbackImportRelocations,
} from '../src/import-relocation.js';

const linux = { skip: process.platform !== 'linux' };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'import-relocation-'));
  const helper = join(directory, 'frameleaf-import-rename');
  childProcess.execFileSync('cc', [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    fileURLToPath(new URL('../import-rename.c', import.meta.url)),
    '-o',
    helper,
  ]);
  const spawn = childProcess.spawn;
  mock.method(childProcess, 'spawn', (command, ...args) =>
    spawn(
      command === '/usr/local/bin/frameleaf-import-rename' ? helper : command,
      ...args,
    ),
  );
  syncBuiltinESMExports();
  const source = join(directory, 'source'),
    destination = join(directory, 'destination');
  await mkdir(source, { mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  const bytes = Buffer.from('synthetic-original-for-reversible-relocation');
  await writeFile(join(source, 'photo.jpg'), bytes);
  const store = new Store(join(directory, 'journal'));
  const operation = store.start('import', 'request', {}).operation;
  const journal = new ImportTransferJournal(store);
  journal.begin(operation.id, {
    manifestSha256: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
  });
  const original = await stat(join(source, 'photo.jpg'), { bigint: true });
  journal.intent(operation.id, {
    id: 'photo',
    mode: 'relocate',
    sourceRoot: 'source',
    destinationRoot: 'destination',
    sourcePath: 'photo.jpg',
    destinationPath: 'photo.jpg',
    bytes: String(bytes.length),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    destinationDevice: String(original.dev),
    sourceIdentity: {
      device: String(original.dev),
      inode: String(original.ino),
      bytes: String(original.size),
      mtimeNs: String(original.mtimeNs),
      ctimeNs: String(original.ctimeNs),
      links: String(original.nlink),
    },
  });
  const roots: Record<string, ImportCopyRoot> = {};
  for (const [key, path] of Object.entries({ source, destination })) {
    const identity = await stat(path, { bigint: true });
    roots[key] = {
      path,
      device: String(identity.dev),
      inode: String(identity.ino),
    };
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
    original,
  };
}
async function clean(f: Awaited<ReturnType<typeof fixture>>) {
  mock.restoreAll();
  syncBuiltinESMExports();
  f.store.close();
  await rm(f.directory, { recursive: true, force: true });
}
test(
  'relocates without copying the inode, durably verifies, and reverses the move',
  linux,
  async () => {
    const f = await fixture();
    try {
      assert.deepEqual(
        await relocateImportFiles(f.journal, f.operation.id, f.roots, false),
        { files: 1, bytes: String(f.bytes.length) },
      );
      await assert.rejects(stat(join(f.source, 'photo.jpg')), {
        code: 'ENOENT',
      });
      assert.equal(
        (await stat(join(f.destination, 'photo.jpg'), { bigint: true })).ino,
        f.original.ino,
      );
      assert.deepEqual(
        await readFile(join(f.destination, 'photo.jpg')),
        f.bytes,
      );
      assert.equal(f.journal.files(f.operation.id)[0].state, 'verified');
      await rollbackImportRelocations(f.journal, f.operation.id, f.roots);
      assert.deepEqual(await readFile(join(f.source, 'photo.jpg')), f.bytes);
      await assert.rejects(stat(join(f.destination, 'photo.jpg')), {
        code: 'ENOENT',
      });
      assert.equal(f.journal.files(f.operation.id)[0].state, 'rolled-back');
      await rollbackImportRelocations(f.journal, f.operation.id, f.roots);
    } finally {
      await clean(f);
    }
  },
);
test(
  'resumes an effect whose verified checkpoint was interrupted',
  linux,
  async () => {
    const f = await fixture();
    try {
      const checkpoint = mock.method(f.journal, 'verified', () => {
        throw new Error('injected checkpoint interruption');
      });
      await assert.rejects(
        relocateImportFiles(f.journal, f.operation.id, f.roots, false),
      );
      checkpoint.mock.restore();
      assert.equal(f.journal.files(f.operation.id)[0].state, 'intent');
      await assert.rejects(stat(join(f.source, 'photo.jpg')), {
        code: 'ENOENT',
      });
      f.store.close();
      f.store = new Store(join(f.directory, 'journal'));
      f.journal = new ImportTransferJournal(f.store);
      await relocateImportFiles(f.journal, f.operation.id, f.roots, true);
      assert.equal(f.journal.files(f.operation.id)[0].state, 'verified');
    } finally {
      await clean(f);
    }
  },
);
test(
  'rollback reconciles a moved intent and a reverse move without its checkpoint',
  linux,
  async () => {
    const f = await fixture();
    try {
      const verified = mock.method(f.journal, 'verified', () => {
        throw new Error('injected interruption');
      });
      await assert.rejects(
        relocateImportFiles(f.journal, f.operation.id, f.roots, false),
      );
      verified.mock.restore();
      const checkpoint = mock.method(f.journal, 'rolledBack', () => {
        throw new Error('injected rollback interruption');
      });
      await assert.rejects(
        rollbackImportRelocations(f.journal, f.operation.id, f.roots),
      );
      checkpoint.mock.restore();
      assert.equal(f.journal.files(f.operation.id)[0].state, 'rollback-intent');
      assert.deepEqual(await readFile(join(f.source, 'photo.jpg')), f.bytes);
      f.store.close();
      f.store = new Store(join(f.directory, 'journal'));
      f.journal = new ImportTransferJournal(f.store);
      await rollbackImportRelocations(f.journal, f.operation.id, f.roots);
      assert.equal(f.journal.files(f.operation.id)[0].state, 'rolled-back');
    } finally {
      await clean(f);
    }
  },
);
test(
  'cancels an unapplied intent without touching the original',
  linux,
  async () => {
    const f = await fixture();
    try {
      await rollbackImportRelocations(f.journal, f.operation.id, f.roots);
      assert.equal(f.journal.files(f.operation.id)[0].state, 'cancelled');
      assert.deepEqual(await readFile(join(f.source, 'photo.jpg')), f.bytes);
      assert.equal(
        (await stat(join(f.source, 'photo.jpg'), { bigint: true })).ctimeNs,
        f.original.ctimeNs,
      );
    } finally {
      await clean(f);
    }
  },
);
test(
  'refuses collisions and changed originals without deleting either file',
  linux,
  async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.destination, 'photo.jpg'), 'unrelated');
      await assert.rejects(
        relocateImportFiles(f.journal, f.operation.id, f.roots, false),
      );
      assert.equal(
        await readFile(join(f.destination, 'photo.jpg'), 'utf8'),
        'unrelated',
      );
      assert.deepEqual(await readFile(join(f.source, 'photo.jpg')), f.bytes);
      await rm(join(f.destination, 'photo.jpg'));
      await writeFile(join(f.source, 'photo.jpg'), 'changed source');
      await assert.rejects(
        relocateImportFiles(f.journal, f.operation.id, f.roots, false),
      );
      assert.equal(
        await readFile(join(f.source, 'photo.jpg'), 'utf8'),
        'changed source',
      );
    } finally {
      await clean(f);
    }
  },
);
test(
  'refuses rollback after the destination writing boundary',
  linux,
  async () => {
    const f = await fixture();
    try {
      await relocateImportFiles(f.journal, f.operation.id, f.roots, false);
      f.journal.writersStarting(f.operation.id);
      await assert.rejects(
        rollbackImportRelocations(f.journal, f.operation.id, f.roots),
        /import_post_activation_recovery_required/,
      );
      assert.deepEqual(
        await readFile(join(f.destination, 'photo.jpg')),
        f.bytes,
      );
    } finally {
      await clean(f);
    }
  },
);

for (const hazard of [
  'hardlink',
  'source-symlink',
  'destination-symlink',
  'public-destination',
  'changed-mount',
] as const) {
  test(
    `refuses ${hazard} without changing unrelated bytes`,
    linux,
    async () => {
      const f = await fixture();
      try {
        const outside = join(f.directory, 'outside');
        await mkdir(outside, { mode: 0o700 });
        await writeFile(join(outside, 'photo.jpg'), 'unrelated');
        if (hazard === 'hardlink')
          await link(join(f.source, 'photo.jpg'), join(f.source, 'alias.jpg'));
        else if (hazard === 'source-symlink') {
          await rename(
            join(f.source, 'photo.jpg'),
            join(f.source, 'retained-original.jpg'),
          );
          await symlink(
            join(outside, 'photo.jpg'),
            join(f.source, 'photo.jpg'),
          );
        } else if (hazard === 'destination-symlink') {
          await rename(f.destination, f.destination + '-retained');
          await symlink(outside, f.destination);
        } else if (hazard === 'public-destination')
          await chmod(f.destination, 0o755);
        else {
          const read = fsPromises.readFile;
          let observed = 0;
          mock.method(fsPromises, 'readFile', async (path, ...options) => {
            const value = await read(path, ...options);
            if (
              String(path).startsWith('/proc/self/fdinfo/') &&
              ++observed === 3
            )
              return String(value).replace(/^mnt_id:\s*\d+$/m, 'mnt_id:\t0');
            return value;
          });
          syncBuiltinESMExports();
        }
        await assert.rejects(
          relocateImportFiles(f.journal, f.operation.id, f.roots, false),
        );
        assert.equal(
          await readFile(join(outside, 'photo.jpg'), 'utf8'),
          'unrelated',
        );
        const original =
          hazard === 'source-symlink' ? 'retained-original.jpg' : 'photo.jpg';
        assert.deepEqual(await readFile(join(f.source, original)), f.bytes);
        assert.equal(f.journal.files(f.operation.id)[0].state, 'intent');
      } finally {
        await clean(f);
      }
    },
  );
}
test('retains both sides of a rollback collision', linux, async () => {
  const f = await fixture();
  try {
    await relocateImportFiles(f.journal, f.operation.id, f.roots, false);
    await writeFile(join(f.source, 'photo.jpg'), 'unrelated');
    await assert.rejects(
      rollbackImportRelocations(f.journal, f.operation.id, f.roots),
      /import_relocation_collision/,
    );
    assert.equal(
      await readFile(join(f.source, 'photo.jpg'), 'utf8'),
      'unrelated',
    );
    assert.deepEqual(await readFile(join(f.destination, 'photo.jpg')), f.bytes);
    assert.equal(f.journal.files(f.operation.id)[0].state, 'rollback-intent');
  } finally {
    await clean(f);
  }
});
test(
  'refuses an unavailable native atomic move without falling back',
  linux,
  async () => {
    const f = await fixture();
    try {
      const shim = join(f.directory, 'unsupported.c'),
        library = join(f.directory, 'unsupported.so');
      await writeFile(
        shim,
        '#include <errno.h>\nlong syscall(long number, ...) { (void)number; errno=ENOSYS; return -1; }\n',
      );
      childProcess.execFileSync('cc', [
        '-shared',
        '-fPIC',
        '-Wall',
        '-Wextra',
        '-Werror',
        shim,
        '-o',
        library,
      ]);
      const spawn = childProcess.spawn;
      mock.method(childProcess, 'spawn', (command, args, options) =>
        spawn(command, args, {
          ...options,
          env: { ...process.env, LD_PRELOAD: library },
        }),
      );
      syncBuiltinESMExports();
      await assert.rejects(
        relocateImportFiles(f.journal, f.operation.id, f.roots, false),
        /import_relocation_atomic_move_unavailable/,
      );
      assert.deepEqual(await readFile(join(f.source, 'photo.jpg')), f.bytes);
      await assert.rejects(stat(join(f.destination, 'photo.jpg')), {
        code: 'ENOENT',
      });
      assert.equal(f.journal.files(f.operation.id)[0].state, 'intent');
    } finally {
      await clean(f);
    }
  },
);

test(
  'reacquires namespace mount identifiers when resuming the same planned roots',
  linux,
  async () => {
    const f = await fixture();
    try {
      const checkpoint = mock.method(f.journal, 'verified', () => {
        throw new Error('checkpoint interruption');
      });
      await assert.rejects(
        relocateImportFiles(f.journal, f.operation.id, f.roots, false),
      );
      checkpoint.mock.restore();
      const read = fsPromises.readFile;
      mock.method(fsPromises, 'readFile', async (path, ...options) => {
        const value = await read(path, ...options);
        return String(path).startsWith('/proc/self/fdinfo/')
          ? String(value).replace(
              /^mnt_id:\s*(\d+)$/m,
              (_line, id) => `mnt_id:\t${BigInt(id) + 100_000n}`,
            )
          : value;
      });
      syncBuiltinESMExports();
      await relocateImportFiles(f.journal, f.operation.id, f.roots, true);
      assert.equal(f.journal.files(f.operation.id)[0].state, 'verified');
      assert.deepEqual(
        await readFile(join(f.destination, 'photo.jpg')),
        f.bytes,
      );
    } finally {
      await clean(f);
    }
  },
);
