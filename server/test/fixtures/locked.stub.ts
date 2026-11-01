import { encryptFile, generateKeyPair } from '@frameleaf/locked-crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { lockedKeys } from 'src/utils/locked-key-holder.js';
import { clearLockedDeferrals, clearLockedPathCache, resetLockedTmpCheck } from 'src/utils/locked-read.js';

/**
 * FL-721: a real sealed file for unit tests of readers (`withPlainCopy`, `openLockedRead`). The plain
 * copies go to a folder under the OS temp dir, allowed with the unsafe development override.
 */
export const lockedFixture = async (ownerId: string) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'locked-fixture-'));
  const tmp = join(dir, 'shm');
  vi.stubEnv('FRAMELEAF_LOCKED_TMP', tmp);
  vi.stubEnv('FRAMELEAF_LOCKED_TMP_ALLOW_DISK', 'true');
  resetLockedTmpCheck();
  clearLockedPathCache();
  clearLockedDeferrals();
  const owner = generateKeyPair();

  /** Seals `plain` at `<dir>/<name>` to the owner's public key. */
  const seal = async (name: string, plain: Buffer | string, mime = 'application/octet-stream') => {
    const source = join(dir, `${name}.plain`);
    const path = join(dir, name);
    await fs.writeFile(source, plain);
    await encryptFile(source, path, [{ publicKey: owner.publicKey }], {
      assetId: '00000000-0000-4000-8000-0000000000a1',
      kind: 'original',
      originalFileName: basename(name),
      mime,
    });
    await fs.rm(source);
    return path;
  };

  return {
    dir,
    tmp,
    owner,
    seal,
    loadKey: () => lockedKeys.load(ownerId, owner.publicKey, Buffer.from(owner.privateKey), null),
    /** Every plain copy made so far has been deleted. */
    copiesLeft: async () => (await fs.readdir(tmp).catch(() => [])).length,
    cleanup: async () => {
      lockedKeys.clear();
      vi.unstubAllEnvs();
      resetLockedTmpCheck();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
};
