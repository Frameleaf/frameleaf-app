import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertOwnerRestoreFile,
  assertOwnerRestorePath,
  captureOwnerRestoreFile,
} from 'src/utils/cloud-backup-owner-path.js';

let folder: string;
beforeEach(async () => {
  folder = await realpath(await mkdtemp(join(tmpdir(), 'owner-restore-')));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});
it('admits a missing nested target only below a current owned root', async () => {
  await expect(assertOwnerRestorePath([folder], join(folder, 'nested', 'own.jpg'))).resolves.toBeUndefined();
});
it('refuses traversal, foreign root and symlinked destinations or ancestors', async () => {
  await mkdir(join(folder, 'own'));
  await writeFile(join(folder, 'other.jpg'), 'foreign');
  await symlink(join(folder, 'other.jpg'), join(folder, 'own', 'linked.jpg'));
  await symlink(folder, join(folder, 'own', 'ancestor'));
  for (const path of [
    join(folder, 'other.jpg'),
    `${folder}/own/../other.jpg`,
    join(folder, 'own', 'linked.jpg'),
    join(folder, 'own', 'ancestor', 'other.jpg'),
  ])
    await expect(assertOwnerRestorePath([join(folder, 'own')], path)).rejects.toThrow('destination unavailable');
});

it('binds a hash to stable file identity and refuses mutation during hashing', async () => {
  const target = join(folder, 'own.jpg');
  await writeFile(target, 'before');
  await expect(
    captureOwnerRestoreFile(target, async () => {
      await writeFile(target, 'after-content');
      return 'old-hash';
    }),
  ).rejects.toThrow('Owner restore original changed');
});
it('refuses changed and appeared targets using lightweight stat evidence', async () => {
  const target = join(folder, 'own.jpg');
  const absent = await captureOwnerRestoreFile(target, vi.fn());
  expect(absent).toEqual({ identity: null, sha256: null, size: null });
  await writeFile(target, 'before');
  await expect(assertOwnerRestoreFile(target, absent.identity)).rejects.toThrow('original changed');
  const present = await captureOwnerRestoreFile(target, () => Promise.resolve('hash'));
  await assertOwnerRestoreFile(target, present.identity);
  await writeFile(target, 'changed-content');
  await expect(assertOwnerRestoreFile(target, present.identity)).rejects.toThrow('original changed');
});

it('keeps inode, size and mtime binding across a real staged rename', async () => {
  const staged = join(folder, 'staged');
  const target = join(folder, 'published');
  await writeFile(staged, 'verified bytes');
  const evidence = await captureOwnerRestoreFile(staged, () => Promise.resolve('verified-hash'));
  await rename(staged, target);
  await assertOwnerRestoreFile(target, evidence.identity, true);
  await writeFile(target, 'changed after publication');
  await expect(assertOwnerRestoreFile(target, evidence.identity, true)).rejects.toThrow('original changed');
});
