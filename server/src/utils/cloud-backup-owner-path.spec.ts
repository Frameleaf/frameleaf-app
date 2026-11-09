import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertOwnerRestoreFile,
  assertOwnerRestorePath,
  assertOwnerRestorePublished,
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

describe('the check after publication (FL-1333)', () => {
  const sha256 = async (path: string) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  const staged = async (bytes: string) => {
    const path = join(folder, 'staged');
    await writeFile(path, bytes);
    return { path, evidence: await captureOwnerRestoreFile(path, sha256) };
  };

  it('accepts the staged file renamed into place, by its identity alone', async () => {
    const { path, evidence } = await staged('verified bytes');
    const target = join(folder, 'published');
    await rename(path, target);
    const hash = vi.fn(sha256);
    await expect(assertOwnerRestorePublished(target, evidence, evidence.sha256!, hash)).resolves.toMatch(/^\d+:/);
    expect(hash).not.toHaveBeenCalled();
  });

  it('accepts a copy holding the checked bytes, and returns the copy’s identity', async () => {
    const { path, evidence } = await staged('verified bytes');
    const target = join(folder, 'published');
    await copyFile(path, target);
    const identity = await assertOwnerRestorePublished(target, evidence, evidence.sha256!, sha256);
    expect(identity).not.toBe(evidence.identity);
    await expect(assertOwnerRestoreFile(target, identity)).resolves.toBeUndefined();
  });

  it.each([
    { label: 'other bytes of the same size', bytes: 'verified bytez' },
    { label: 'another size', bytes: 'not the verified bytes' },
  ])('refuses a copy holding $label', async ({ bytes }) => {
    const { evidence } = await staged('verified bytes');
    const target = join(folder, 'published');
    await writeFile(target, bytes);
    await expect(assertOwnerRestorePublished(target, evidence, evidence.sha256!, sha256)).rejects.toThrow(
      'Owner restore original changed',
    );
  });

  it('refuses a copy that has a second name, and nothing at all', async () => {
    const { path, evidence } = await staged('verified bytes');
    const target = join(folder, 'published');
    await expect(assertOwnerRestorePublished(target, evidence, evidence.sha256!, sha256)).rejects.toThrow(
      'Owner restore original changed',
    );
    await copyFile(path, target);
    await link(target, join(folder, 'second name'));
    await expect(assertOwnerRestorePublished(target, evidence, evidence.sha256!, sha256)).rejects.toThrow(
      'Owner restore destination unavailable',
    );
  });
});
