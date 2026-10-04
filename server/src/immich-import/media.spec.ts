import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapMediaPath, verifyMediaFile } from 'src/immich-import/media.js';

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
    await expect(verifyMediaFile(source, roots, String.raw`\x${checksum}`, 'sha1')).resolves.toBe(target);
    await expect(verifyMediaFile(source, roots, '0'.repeat(40), 'sha1')).rejects.toThrow('ORIGINAL_CHECKSUM_MISMATCH');
    await writeFile(target, 'modified bytes');
    await expect(verifyMediaFile(source, roots)).rejects.toThrow('MEDIA_CHANGED_OR_MISMATCHED');
  });

  it('refuses same paths, symlink root aliases, and hardlinked destination files', async () => {
    const sourceRoot = join(directory, 'source');
    const targetRoot = join(directory, 'target');
    const source = join(sourceRoot, 'photo.jpg');
    await writeFile(source, 'photo');
    await expect(verifyMediaFile(source, [{ source: sourceRoot, target: sourceRoot }])).rejects.toThrow(
      'INDEPENDENT_COPY',
    );
    await symlink(sourceRoot, join(directory, 'alias'));
    await expect(verifyMediaFile(source, [{ source: sourceRoot, target: join(directory, 'alias') }])).rejects.toThrow(
      'INDEPENDENT_COPY',
    );
    await link(source, join(targetRoot, 'photo.jpg'));
    await expect(verifyMediaFile(source, [{ source: sourceRoot, target: targetRoot }])).rejects.toThrow(
      'INDEPENDENT_COPY',
    );
    expect(await readFile(source, 'utf8')).toBe('photo');
  });

  it('refuses a destination hardlink to a different source file with identical bytes', async () => {
    const sourceRoot = join(directory, 'source');
    const targetRoot = join(directory, 'target');
    await writeFile(join(sourceRoot, 'photo.jpg'), 'photo');
    await writeFile(join(sourceRoot, 'other.jpg'), 'photo');
    await link(join(sourceRoot, 'other.jpg'), join(targetRoot, 'photo.jpg'));
    await expect(
      verifyMediaFile(join(sourceRoot, 'photo.jpg'), [{ source: sourceRoot, target: targetRoot }]),
    ).rejects.toThrow('INDEPENDENT_COPY');
  });

  it('refuses target roots nested inside any source root, including another mapping', async () => {
    const sourceRoot = join(directory, 'source');
    const targetRoot = join(directory, 'target');
    await mkdir(join(sourceRoot, 'nested'));
    await writeFile(join(sourceRoot, 'photo.jpg'), 'photo');
    await writeFile(join(targetRoot, 'photo.jpg'), 'photo');
    await expect(
      verifyMediaFile(join(sourceRoot, 'photo.jpg'), [
        { source: sourceRoot, target: targetRoot },
        { source: targetRoot, target: join(sourceRoot, 'nested') },
      ]),
    ).rejects.toThrow('INDEPENDENT_COPY');
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
