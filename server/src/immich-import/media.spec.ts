import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapMediaPath, verifyMediaFile } from './media.js';

describe('offline media verification', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-import-'));
    await mkdir(join(directory, 'source'));
    await mkdir(join(directory, 'target'));
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  it('checks original checksum and target bytes without modifying either file', async () => {
    const source = join(directory, 'source', 'photo.jpg');
    const target = join(directory, 'target', 'photo.jpg');
    await writeFile(source, 'original bytes');
    await writeFile(target, 'original bytes');
    const checksum = createHash('sha1').update('original bytes').digest('hex');
    const roots = [{ source: join(directory, 'source'), target: join(directory, 'target') }];
    await expect(verifyMediaFile(source, roots, `\\x${checksum}`, 'sha1')).resolves.toBe(target);
    await expect(verifyMediaFile(source, roots, '0'.repeat(40), 'sha1')).rejects.toThrow('ORIGINAL_CHECKSUM_MISMATCH');
    await writeFile(target, 'modified bytes');
    await expect(verifyMediaFile(source, roots)).rejects.toThrow('MEDIA_CHANGED_OR_MISMATCHED');
  });

  it('checks legacy external path hashes using the original upstream path', async () => {
    const source = join(directory, 'source', 'photo.jpg');
    await writeFile(source, 'photo');
    await writeFile(join(directory, 'target', 'photo.jpg'), 'photo');
    const roots = [{ source: join(directory, 'source'), target: join(directory, 'target') }];
    await expect(
      verifyMediaFile(source, roots, createHash('sha1').update(`path:${source}`).digest('hex'), 'sha1-path'),
    ).resolves.toBe(join(directory, 'target', 'photo.jpg'));
  });

  it('refuses traversal, prefix confusion, overlapping maps and symlink escape', async () => {
    const roots = [{ source: join(directory, 'source'), target: join(directory, 'target') }];
    expect(() => mapMediaPath(`${directory}/source/../secret`, roots)).toThrow('UNSAFE_MEDIA_PATH');
    expect(() => mapMediaPath(`${directory}/source-other/a`, roots)).toThrow('UNMAPPED');
    expect(() => mapMediaPath(`${directory}/source/a`, [...roots, ...roots])).toThrow('AMBIGUOUS');
    await writeFile(join(directory, 'secret'), 'secret');
    await symlink(join(directory, 'secret'), join(directory, 'source', 'photo.jpg'));
    await writeFile(join(directory, 'target', 'photo.jpg'), 'secret');
    await expect(verifyMediaFile(join(directory, 'source', 'photo.jpg'), roots)).rejects.toThrow(
      'MEDIA_SYMLINK_ESCAPE',
    );
  });
});
