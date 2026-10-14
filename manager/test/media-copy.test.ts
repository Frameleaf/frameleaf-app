import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const { freeze, copy, verify } = createRequire(import.meta.url)('../media-copy.cjs');

async function fixture(run: (source: string, destination: string, manifest: string, cancel: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'manager-media-move-'));
  const source = join(root, 'source'),
    destination = join(root, 'destination');
  await mkdir(source);
  await mkdir(destination);
  try {
    await run(source, destination, join(root, 'manifest.json'), join(root, 'cancel'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('copy independently verifies all bytes and preserves POSIX metadata and empty directories', async () => {
  await fixture(async (source, destination, manifest, cancel) => {
    await mkdir(join(source, 'empty'));
    await writeFile(join(source, '写真\n name.jpg'), 'original');
    await writeFile(join(source, 'zero'), '');
    await chmod(join(source, 'zero'), 0o640);
    await utimes(join(source, 'zero'), 100000, 100000);
    const before = await freeze(source, manifest);
    await copy(source, destination, manifest, cancel);
    await verify(source, destination, manifest);
    assert.equal(before.files, 2);
    assert.equal(before.bytes, 8);
    assert.equal(await readFile(join(source, '写真\n name.jpg'), 'utf8'), 'original');
    assert.equal((await stat(join(destination, 'zero'))).mode & 0o777, 0o640);
    assert.equal((await stat(join(destination, 'zero'))).mtimeMs, 100000000);
    assert.ok((await stat(join(destination, 'empty'))).isDirectory());
  });
});
test('source links are refused without following them', async () => {
  await fixture(async (source, _destination, manifest) => {
    await symlink('/outside-the-authorized-library', join(source, 'link'));
    await assert.rejects(freeze(source, manifest), /unsupported_media_entry/);
  });
});
test('changed source or destination bytes and unexpected files refuse verification', async () => {
  await fixture(async (source, destination, manifest, cancel) => {
    await writeFile(join(source, 'photo'), 'original');
    await freeze(source, manifest);
    await copy(source, destination, manifest, cancel);
    await writeFile(join(destination, 'photo'), 'damaged');
    await assert.rejects(verify(source, destination, manifest), /media_copy_mismatch/);
    await copy(source, destination, manifest, cancel);
    await writeFile(join(destination, 'extra'), 'unexpected');
    await assert.rejects(verify(source, destination, manifest), /media_copy_mismatch/);
    await rm(join(destination, 'extra'));
    await writeFile(join(source, 'photo'), 'modified');
    await assert.rejects(copy(source, destination, manifest, cancel), /media_source_changed/);
  });
});
test('cancellation preserves the original and retry can finish an incomplete owned destination', async () => {
  await fixture(async (source, destination, manifest, cancel) => {
    await writeFile(join(source, 'photo'), 'original');
    await freeze(source, manifest);
    await writeFile(cancel, 'stop');
    await assert.rejects(copy(source, destination, manifest, cancel), /media_move_cancelled/);
    assert.equal(await readFile(join(source, 'photo'), 'utf8'), 'original');
    await rm(cancel);
    await writeFile(join(destination, 'photo'), 'partial');
    await copy(source, destination, manifest, cancel);
    await verify(source, destination, manifest);
  });
});
test('destination symlinks refuse copying rather than writing through them', async () => {
  await fixture(async (source, destination, manifest, cancel) => {
    await writeFile(join(source, 'photo'), 'original');
    await freeze(source, manifest);
    await symlink(join(source, 'photo'), join(destination, 'photo'));
    await assert.rejects(copy(source, destination, manifest, cancel), /unsupported_media_entry/);
    assert.equal(await readFile(join(source, 'photo'), 'utf8'), 'original');
  });
});

test('extended attributes must survive the copy and changed attributes refuse verification', async () => {
  await fixture(async (source, destination, manifest, cancel) => {
    const from = join(source, 'photo'),
      to = join(destination, 'photo');
    await writeFile(from, 'original');
    const set = (path: string, value: string) =>
      process.platform === 'linux'
        ? execFileSync('setfattr', ['-n', 'user.frameleaf', '-v', value, '--', path])
        : execFileSync('/usr/bin/xattr', ['-w', 'com.frameleaf.fixture', value, path]);
    set(from, 'retained');
    await freeze(source, manifest);
    await copy(source, destination, manifest, cancel);
    await verify(source, destination, manifest);
    set(to, 'changed');
    await assert.rejects(verify(source, destination, manifest), /media_copy_mismatch/);
  });
});

test('an ACL change at the destination refuses verification', async () => {
  await fixture(async (source, destination, manifest, cancel) => {
    const from = join(source, 'photo'),
      to = join(destination, 'photo');
    await writeFile(from, 'original');
    const set = (path: string, read: boolean) =>
      process.platform === 'linux'
        ? execFileSync('setfacl', ['-m', `u:12345:${read ? 'r' : 'w'}--`, '--', path])
        : execFileSync('/bin/chmod', ['+a', `everyone allow ${read ? 'read' : 'write'}`, path]);
    set(from, true);
    await freeze(source, manifest);
    await copy(source, destination, manifest, cancel);
    await verify(source, destination, manifest);
    set(to, false);
    await assert.rejects(verify(source, destination, manifest), /media_copy_mismatch/);
  });
});
