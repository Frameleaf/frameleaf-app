import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealedOwnerKeyIdOrUnreadable, unreadableLockedKeyId } from 'src/utils/locked-backup.js';

describe('sealedOwnerKeyIdOrUnreadable (FL-1500)', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'locked-backup-'));
  });
  afterEach(() => rm(folder, { recursive: true, force: true }));

  it('reports a header that does not parse', async () => {
    const path = join(folder, 'IMG_1.jpg');
    await writeFile(path, Buffer.concat([Buffer.from('FLLK', 'ascii'), Buffer.from('not a header')]));
    await expect(sealedOwnerKeyIdOrUnreadable(path)).resolves.toBe(unreadableLockedKeyId(path));
  });

  it('throws a filesystem error instead of calling the file unreadable', async () => {
    await expect(sealedOwnerKeyIdOrUnreadable(join(folder, 'gone.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
