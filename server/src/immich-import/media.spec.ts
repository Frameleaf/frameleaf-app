import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertMediaPolicy, mapMediaPath, verifyMediaFile, verifyMediaRoots } from 'src/immich-import/media.js';

describe('offline media verification', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-import-'));
    await mkdir(join(directory, 'source'));
    await mkdir(join(directory, 'target'));
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  const manager = {
    mode: 'manager-in-place' as const,
    authority: 'frameleaf-manager' as const,
    operationId: 'operation-1',
    deploymentId: 'deployment-1',
  };

  it('validates empty independent roots and preserves same-path nested Manager mounts', async () => {
    const source = join(directory, 'source');
    const target = join(directory, 'target');
    await expect(verifyMediaRoots([{ source, target }])).resolves.toBeUndefined();
    await expect(verifyMediaRoots([{ source, target }], { mode: 'independent-copy' })).resolves.toBeUndefined();
    await expect(verifyMediaRoots([{ source, target: source }])).rejects.toThrow('INDEPENDENT_COPY');
    await symlink(source, join(directory, 'alias'));
    await expect(verifyMediaRoots([{ source, target: join(directory, 'alias') }])).rejects.toThrow('INDEPENDENT_COPY');
    const nested = join(source, 'nested');
    await mkdir(nested);
    await expect(verifyMediaRoots([{ source, target: nested }])).rejects.toThrow('INDEPENDENT_COPY');
    await expect(verifyMediaRoots([{ source: nested, target: source }])).rejects.toThrow('INDEPENDENT_COPY');
    await expect(
      verifyMediaRoots([
        { source, target },
        { source: target, target: nested },
      ]),
    ).rejects.toThrow('INDEPENDENT_COPY');
    await expect(
      verifyMediaRoots(
        [
          { source, target: source },
          { source: nested, target: nested },
        ],
        manager,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects noncanonical, overlapping and nondirectory roots without requiring a media row', async () => {
    const source = join(directory, 'source');
    const target = join(directory, 'target');
    await expect(verifyMediaRoots([{ source: 'relative', target }])).rejects.toThrow('UNSAFE_MEDIA_ROOT');
    await expect(verifyMediaRoots([{ source: `${source}/../source`, target }])).rejects.toThrow('UNSAFE_MEDIA_ROOT');
    await expect(
      verifyMediaRoots([
        { source, target },
        { source, target },
      ]),
    ).rejects.toThrow('AMBIGUOUS');
    await writeFile(join(directory, 'file'), 'not a directory');
    await expect(verifyMediaRoots([{ source, target: join(directory, 'file') }])).rejects.toThrow('DIRECTORY');
  });

  it('retains Manager media at exactly the same path while checking original bytes', async () => {
    const root = join(directory, 'source');
    const path = join(root, 'photo.jpg');
    await writeFile(path, 'original');
    const roots = [{ source: root, target: root }];
    const checksum = createHash('sha1').update('original').digest('hex');
    const receipt = vi.fn();
    await expect(verifyMediaFile(path, roots, checksum, 'sha1', manager, receipt)).resolves.toBe(path);
    expect(receipt).toHaveBeenCalledWith(createHash('sha256').update('original').digest('hex'));
    await writeFile(path, 'modified');
    await expect(verifyMediaFile(path, roots, checksum, 'sha1', manager)).rejects.toThrow('ORIGINAL_CHECKSUM_MISMATCH');
    expect(await readFile(path, 'utf8')).toBe('modified');
  });

  it('uses the most specific Manager mount and rejects duplicate destinations', () => {
    const roots = [
      { source: '/data', target: '/data' },
      { source: '/data/library', target: '/data/library' },
    ];
    expect(mapMediaPath('/data/library/photo.jpg', roots, manager).root).toBe(roots[1]);
    expect(mapMediaPath('/data/library/photo.jpg', roots.toReversed(), manager).root).toBe(roots[1]);
    expect(mapMediaPath('/data/photo.jpg', roots, manager).root).toBe(roots[0]);
    expect(() => mapMediaPath('/data/library/photo.jpg', roots)).toThrow('AMBIGUOUS');
    expect(() => mapMediaPath('/data/library/photo.jpg', [...roots, roots[1]], manager)).toThrow('AMBIGUOUS');
    expect(() => mapMediaPath('/data/photo.jpg', [...roots, roots[1]], manager)).toThrow('AMBIGUOUS');
  });

  it('verifies nested Manager media against its own mount boundary', async () => {
    const root = join(directory, 'source');
    const nested = join(root, 'library');
    await mkdir(nested);
    const path = join(nested, 'photo.jpg');
    await writeFile(path, 'original');
    const roots = [
      { source: root, target: root },
      { source: nested, target: nested },
    ];
    await expect(verifyMediaFile(path, roots, undefined, undefined, manager)).resolves.toBe(path);
    await writeFile(join(root, 'outside.jpg'), 'original');
    const escape = join(nested, 'escape.jpg');
    await symlink(join(root, 'outside.jpg'), escape);
    await expect(verifyMediaFile(escape, roots, undefined, undefined, manager)).rejects.toThrow('MEDIA_SYMLINK_ESCAPE');
  });

  it('rejects Manager remapping and incomplete authority', () => {
    expect(() => assertMediaPolicy([{ source: '/source', target: '/target' }], manager)).toThrow('LOCATIONS');
    expect(() =>
      assertMediaPolicy([{ source: '/source', target: '/source' }], { ...manager, operationId: '' }),
    ).toThrow('AUTHORITY');
    expect(() => assertMediaPolicy([{ source: '/source/../media', target: '/source/../media' }], manager)).toThrow(
      'LOCATIONS',
    );
  });

  it('retains symlink-containment checks for Manager in-place files', async () => {
    const root = join(directory, 'source');
    const path = join(root, 'photo.jpg');
    await writeFile(join(directory, 'outside'), 'original');
    await symlink(join(directory, 'outside'), path);
    await expect(
      verifyMediaFile(path, [{ source: root, target: root }], undefined, undefined, manager),
    ).rejects.toThrow('MEDIA_SYMLINK_ESCAPE');
  });

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
