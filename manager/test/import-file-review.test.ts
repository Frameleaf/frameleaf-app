import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  open,
  utimes,
  rename,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  symlink,
  link,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { test, mock } from 'node:test';
import { reviewImportFiles } from '../src/import-file-review.js';
import { reviewedImport } from './import-plan-fixture.js';

const linux = { skip: process.platform !== 'linux' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'import-file-review-'));
  const source = join(root, 'source'),
    destination = join(root, 'destination');
  await mkdir(source, { mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  const bytes = Buffer.from(
    'synthetic original bytes, independent of source path hashes',
  );
  await writeFile(join(source, 'original.jpg'), bytes, { mode: 0o640 });
  const roots = await Promise.all(
    [source, destination].map(async (path, index) => {
      const info = await stat(path, { bigint: true });
      return {
        id: index ? 'destination' : 'source',
        path,
        device: String(info.dev),
        inode: String(info.ino),
      };
    }),
  );
  const input = {
    ...reviewedImport([]).plan,
    version: 2 as const,
    roots,
    files: [
      {
        id: 'placement',
        sourceAssetId: 'photo',
        sourceFileId: 'original',
        sourceRoot: 'source',
        sourcePath: 'original.jpg',
        destinationRoot: 'destination',
        destinationPath: 'original.jpg',
      },
    ],
  };
  return {
    root,
    source,
    destination,
    bytes,
    input,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
for (const kind of [
  'immich',
  'photoprism',
  'librephotos',
  'photoview',
  'piwigo',
  'lychee',
  'pigallery2',
  'ente',
  'nextcloud',
  'synology',
] as const) {
  test(
    `independently reviews original bytes for ${kind} through the same transfer contract`,
    linux,
    async () => {
      const f = await fixture();
      try {
        f.input.source.kind = kind;
        const before = await stat(join(f.source, 'original.jpg'), {
          bigint: true,
        });
        const plan = await reviewImportFiles(f.input);
        assert.equal(plan.source.kind, kind);
        assert.equal(plan.version, 2);
        assert.deepEqual(plan.files[0], {
          ...f.input.files[0],
          mode: 'copy',
          bytes: String(f.bytes.length),
          sha256: createHash('sha256').update(f.bytes).digest('hex'),
          sourceIdentity: {
            device: String(before.dev),
            inode: String(before.ino),
            bytes: String(before.size),
            mtimeNs: String(before.mtimeNs),
            ctimeNs: String(before.ctimeNs),
            links: String(before.nlink),
          },
          destinationDevice: f.input.roots[1].device,
        });
        assert.deepEqual(
          await readFile(join(f.source, 'original.jpg')),
          f.bytes,
        );
        assert.equal(
          (await stat(join(f.source, 'original.jpg'), { bigint: true })).mode,
          before.mode,
        );
        await assert.rejects(readFile(join(f.destination, 'original.jpg')), {
          code: 'ENOENT',
        });
      } finally {
        await f.cleanup();
      }
    },
  );
}
for (const change of [
  { sourcePath: '../outside' },
  { sourcePath: '/absolute' },
  { sourcePath: 'sub/../original.jpg' },
  { expectedSha256: 'a'.repeat(64) },
  { expectedBytes: '999' },
  { password: 'must not be accepted' },
])
  test(
    `refuses unsafe or conflicting original evidence: ${JSON.stringify(change)}`,
    linux,
    async () => {
      const f = await fixture();
      try {
        Object.assign(f.input.files[0], change);
        await assert.rejects(
          reviewImportFiles(f.input),
          /import_file_review_|import_plan_invalid/,
        );
      } finally {
        await f.cleanup();
      }
    },
  );
for (const type of ['symlink', 'directory', 'fifo'])
  test(
    `refuses ${type} originals without following or blocking`,
    linux,
    async () => {
      const f = await fixture();
      try {
        await rm(join(f.source, 'original.jpg'));
        if (type === 'symlink')
          await symlink('/etc/passwd', join(f.source, 'original.jpg'));
        else if (type === 'directory')
          await mkdir(join(f.source, 'original.jpg'));
        else execFileSync('mkfifo', [join(f.source, 'original.jpg')]);
        await assert.rejects(reviewImportFiles(f.input), /import_file_review_/);
      } finally {
        await f.cleanup();
      }
    },
  );
for (const mode of ['adopt', 'relocate'])
  test(`refuses hardlinked ${mode} originals`, linux, async () => {
    const f = await fixture();
    try {
      await link(join(f.source, 'original.jpg'), join(f.source, 'second.jpg'));
      Object.assign(f.input.files[0], { mode });
      await assert.rejects(reviewImportFiles(f.input), /import_file_review_/);
    } finally {
      await f.cleanup();
    }
  });
test(
  'rejects changed reviewed roots and destination collisions',
  linux,
  async () => {
    const f = await fixture();
    try {
      const bad = structuredClone(f.input);
      bad.roots[0].inode = '0';
      await assert.rejects(reviewImportFiles(bad), /import_file_review_/);
      await writeFile(join(f.destination, 'original.jpg'), 'unrelated');
      await assert.rejects(reviewImportFiles(f.input), /import_file_review_/);
      assert.equal(
        await readFile(join(f.destination, 'original.jpg'), 'utf8'),
        'unrelated',
      );
    } finally {
      await f.cleanup();
    }
  },
);
test(
  'retains separate placements for one shared original and verifies supplied byte evidence',
  linux,
  async () => {
    const f = await fixture();
    try {
      Object.assign(f.input.files[0], {
        expectedBytes: String(f.bytes.length),
        expectedSha256: createHash('sha256').update(f.bytes).digest('hex'),
      });
      f.input.files.push({
        ...f.input.files[0],
        id: 'second-placement',
        sourceAssetId: 'second-photo',
        destinationPath: 'second.jpg',
      });
      const plan = await reviewImportFiles(f.input);
      assert.equal(plan.files.length, 2);
      assert.equal(plan.files[0].sha256, plan.files[1].sha256);
      assert.equal(
        plan.files[0].sourceIdentity.inode,
        plan.files[1].sourceIdentity.inode,
      );
      assert.equal('expectedSha256' in plan.files[0], false);
    } finally {
      await f.cleanup();
    }
  },
);
test(
  'adopts only the same directory entry through distinct reviewed roots',
  linux,
  async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.source, 'nested'));
      await writeFile(join(f.source, 'nested/original.jpg'), f.bytes);
      const info = await stat(join(f.source, 'nested'), { bigint: true });
      f.input.roots[1] = {
        id: 'destination',
        path: join(f.source, 'nested'),
        device: String(info.dev),
        inode: String(info.ino),
      };
      Object.assign(f.input.files[0], {
        mode: 'adopt',
        sourcePath: 'nested/original.jpg',
      });
      const plan = await reviewImportFiles(f.input);
      assert.equal(plan.files[0].mode, 'adopt');
    } finally {
      await f.cleanup();
    }
  },
);

for (const change of ['bytes', 'path', 'root'])
  test(`refuses source ${change} changes during hashing`, linux, async () => {
    const f = await fixture();
    const probe = await open(join(f.source, 'original.jpg'), 'r');
    const prototype = Object.getPrototypeOf(probe);
    const original = prototype.createReadStream;
    let changed = false;
    let mutationCompleted = false;
    const intercepted = mock.method(
      prototype,
      'createReadStream',
      function (this: unknown, ...args: unknown[]) {
        if (!changed) {
          changed = true;
          const stream = original.apply(this, args);
          return Readable.from(
            (async function* () {
              for await (const chunk of stream) {
                if (mutationCompleted) {
                  yield chunk;
                  continue;
                }
                if (change === 'bytes')
                  await writeFile(
                    join(f.source, 'original.jpg'),
                    'changed source',
                  );
                else if (change === 'path') {
                  await rename(
                    join(f.source, 'original.jpg'),
                    join(f.source, 'saved.jpg'),
                  );
                  await writeFile(join(f.source, 'original.jpg'), f.bytes);
                } else {
                  await rename(f.source, join(f.root, 'saved-source'));
                  await mkdir(f.source);
                  await writeFile(join(f.source, 'original.jpg'), f.bytes);
                }
                mutationCompleted = true;
                yield chunk;
              }
            })(),
          );
        }
        return original.apply(this, args);
      },
    );
    try {
      await assert.rejects(reviewImportFiles(f.input), /import_file_review_/);
      assert.equal(changed, true);
      assert.equal(mutationCompleted, true);
    } finally {
      intercepted.mock.restore();
      await probe.close();
      await f.cleanup();
    }
  });
test(
  'refuses cross-filesystem relocation using the actual reviewed mounts',
  linux,
  async () => {
    const f = await fixture();
    const other = await mkdtemp('/dev/shm/import-file-review-');
    try {
      const info = await stat(other, { bigint: true });
      assert.notEqual(String(info.dev), f.input.roots[0].device);
      f.input.roots[1] = {
        id: 'destination',
        path: other,
        device: String(info.dev),
        inode: String(info.ino),
      };
      Object.assign(f.input.files[0], { mode: 'relocate' });
      await assert.rejects(
        reviewImportFiles(f.input),
        /import_file_review_cross_filesystem/,
      );
    } finally {
      await rm(other, { recursive: true, force: true });
      await f.cleanup();
    }
  },
);
test(
  'rejects separately copied adoption bytes and unsafe header fields',
  linux,
  async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.destination, 'original.jpg'), f.bytes);
      Object.assign(f.input.files[0], { mode: 'adopt' });
      await assert.rejects(
        reviewImportFiles(f.input),
        /import_file_review_adoption_layout/,
      );
      await assert.rejects(
        reviewImportFiles({ ...f.input, credential: 'private' }),
        /import_plan_invalid/,
      );
    } finally {
      await f.cleanup();
    }
  },
);
test(
  'captures draft input before asynchronous reads can rebind it',
  linux,
  async () => {
    const f = await fixture();
    try {
      const pending = reviewImportFiles(f.input);
      f.input.roots[0].path = '/unrelated';
      f.input.files[0].sourcePath = 'different.jpg';
      const plan = await pending;
      assert.equal(plan.files[0].sourcePath, 'original.jpg');
      assert.equal(plan.roots[0].path, f.source);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'reviews same-filesystem relocation without moving the source',
  linux,
  async () => {
    const f = await fixture();
    try {
      Object.assign(f.input.files[0], { mode: 'relocate' });
      const plan = await reviewImportFiles(f.input);
      assert.equal(plan.files[0].mode, 'relocate');
      assert.deepEqual(await readFile(join(f.source, 'original.jpg')), f.bytes);
      await assert.rejects(readFile(join(f.destination, 'original.jpg')), {
        code: 'ENOENT',
      });
    } finally {
      await f.cleanup();
    }
  },
);
test(
  'permits independently hashed source hardlinks in copy mode',
  linux,
  async () => {
    const f = await fixture();
    try {
      await link(join(f.source, 'original.jpg'), join(f.source, 'second.jpg'));
      const plan = await reviewImportFiles(f.input);
      assert.equal(plan.files[0].mode, 'copy');
      assert.equal(plan.files[0].sourceIdentity.links, '2');
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'rejects absent destination entries aliased through a bind mount',
  linux,
  async (t) => {
    const f = await fixture();
    const alias = join(f.root, 'alias');
    let mounted = false;
    try {
      await mkdir(join(f.destination, 'sub'));
      await mkdir(alias);
      try {
        execFileSync('mount', ['--bind', join(f.destination, 'sub'), alias], {
          stdio: 'ignore',
        });
        mounted = true;
      } catch {
        t.skip('Requires bind mount capability');
        return;
      }
      const info = await stat(alias, { bigint: true });
      f.input.roots.push({
        id: 'alias',
        path: alias,
        device: String(info.dev),
        inode: String(info.ino),
      });
      f.input.files[0].destinationPath = 'sub/original.jpg';
      f.input.files.push({
        ...f.input.files[0],
        id: 'second-placement',
        sourceAssetId: 'second-photo',
        destinationRoot: 'alias',
        destinationPath: 'original.jpg',
      });
      await assert.rejects(
        reviewImportFiles(f.input),
        /import_file_review_destination_alias/,
      );
    } finally {
      // Never remove a directory while a synthetic mount remains attached.
      if (mounted) execFileSync('umount', [alias]);
      await f.cleanup();
    }
  },
);

test(
  'reviews originals with modification dates before the Unix epoch',
  linux,
  async () => {
    const f = await fixture();
    try {
      await utimes(
        join(f.source, 'original.jpg'),
        new Date('1965-01-02T03:04:05Z'),
        new Date('1965-01-02T03:04:05Z'),
      );
      const before = await stat(join(f.source, 'original.jpg'), {
        bigint: true,
      });
      assert.ok(before.mtimeNs < 0n);
      const plan = await reviewImportFiles(f.input);
      assert.equal(
        plan.files[0].sourceIdentity.mtimeNs,
        String(before.mtimeNs),
      );
    } finally {
      await f.cleanup();
    }
  },
);
