import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBundleFiles } from 'src/library-import/files.js';
import { parseImportManifest } from 'src/library-import/manifest.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const content = Buffer.from('synthetic original media');
const manifest = () =>
  parseImportManifest({
    format: 'frameleaf-library-import',
    version: 1,
    source: { kind: 'ente', version: 'fixture', identity: 'account', revision: 'rev', schemaSha256: 'a'.repeat(64) },
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: 'rev',
      revisionAfter: 'rev',
    },
    users: [{ id: 'u1', name: 'Owner' }],
    files: [
      {
        id: 'f1',
        path: 'album/original.jpg',
        bytes: String(content.length),
        sha256: createHash('sha256').update(content).digest('hex'),
        role: 'original',
      },
    ],
    assets: [{ id: 'a1', ownerId: 'u1', fileIds: ['f1'], visibility: 'timeline', metadata: {} }],
    albums: [],
    losses: [],
  });

describe.skipIf(process.platform !== 'linux')('bundle original verification', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frameleaf-import-'));
    await mkdir(join(root, 'album'));
    await writeFile(join(root, 'album/original.jpg'), content);
  });
  afterEach(async () => {
    vi.mocked(open).mockReset();
    vi.mocked(open).mockImplementation(
      (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open,
    );
    await rm(root, { recursive: true, force: true });
  });

  it('verifies bytes and hashes without modifying originals', async () => {
    const result = await verifyBundleFiles(root, manifest());
    expect(result).toEqual({ files: 1, bytes: String(content.length) });
    expect(await readFile(join(root, 'album/original.jpg'))).toEqual(content);
  });
  it('refuses byte-length changes', async () => {
    await writeFile(join(root, 'album/original.jpg'), 'short');
    await expect(verifyBundleFiles(root, manifest())).rejects.toThrow('BUNDLE_FILE_MISMATCH');
  });
  it('refuses changed bytes even when length matches', async () => {
    await writeFile(join(root, 'album/original.jpg'), Buffer.alloc(content.length));
    await expect(verifyBundleFiles(root, manifest())).rejects.toThrow('BUNDLE_FILE_MISMATCH');
  });
  it('refuses missing originals without leaking filesystem errors', async () => {
    await rm(join(root, 'album/original.jpg'));
    await expect(verifyBundleFiles(root, manifest())).rejects.toThrow('BUNDLE_FILE_UNAVAILABLE');
  });
  it('resolves Ente-style links contained within the export', async () => {
    await writeFile(join(root, 'shared.jpg'), content);
    await rm(join(root, 'album/original.jpg'));
    await symlink('../shared.jpg', join(root, 'album/original.jpg'));
    await expect(verifyBundleFiles(root, manifest())).resolves.toEqual({ files: 1, bytes: String(content.length) });
  });
  it('resolves parent segments after intervening contained symlinks', async () => {
    await mkdir(join(root, 'nested/deep'), { recursive: true });
    await writeFile(join(root, 'nested/photo.jpg'), content);
    await symlink('nested/deep', join(root, 'shortcut'));
    await rm(join(root, 'album/original.jpg'));
    await symlink('../shortcut/../photo.jpg', join(root, 'album/original.jpg'));
    await expect(verifyBundleFiles(root, manifest())).resolves.toEqual({ files: 1, bytes: String(content.length) });
  });
  it('refuses links outside the bundle', async () => {
    await rm(join(root, 'album/original.jpg'));
    await symlink(tmpdir(), join(root, 'album/original.jpg'));
    await expect(verifyBundleFiles(root, manifest())).rejects.toThrow('BUNDLE_PATH_ESCAPE');
  });
  it('refuses directory entries pretending to be originals', async () => {
    await rm(join(root, 'album/original.jpg'));
    await mkdir(join(root, 'album/original.jpg'));
    await expect(verifyBundleFiles(root, manifest())).rejects.toThrow('BUNDLE_FILE_MISMATCH');
  });
  it('never reads outside bytes when an ancestor is swapped immediately before open', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'frameleaf-outside-'));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let swapped = false;
    let outsideFileOpened = false;
    await writeFile(join(outside, 'original.jpg'), content);
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (String(path).startsWith('/proc/self/fd/') && String(path).endsWith('/album') && !swapped) {
        swapped = true;
        await rename(join(root, 'album'), join(root, 'saved-album'));
        await symlink(outside, join(root, 'album'));
      }
      if (swapped && String(path).endsWith('/original.jpg')) outsideFileOpened = true;
      return actual.open(path, flags, mode);
    });
    try {
      await expect(verifyBundleFiles(root, manifest())).rejects.toThrow('BUNDLE_FILE_UNAVAILABLE');
      expect(swapped).toBe(true);
      expect(outsideFileOpened).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  it('refuses a swapped root ancestor before opening any outside media', async () => {
    const target = join(root, 'bundle/library');
    const outside = await mkdtemp(join(tmpdir(), 'frameleaf-root-outside-'));
    await mkdir(join(target, 'album'), { recursive: true });
    await writeFile(join(target, 'album/original.jpg'), content);
    await mkdir(join(outside, 'library/album'), { recursive: true });
    await writeFile(join(outside, 'library/album/original.jpg'), content);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let swapped = false;
    let outsideFileOpened = false;
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith('/bundle') && !swapped) {
        swapped = true;
        await rename(join(root, 'bundle'), join(root, 'saved-bundle'));
        await symlink(outside, join(root, 'bundle'));
        try {
          return await actual.open(path, flags, mode);
        } finally {
          await rm(join(root, 'bundle'));
          await rename(join(root, 'saved-bundle'), join(root, 'bundle'));
        }
      }
      if (swapped && String(path).endsWith('/original.jpg')) outsideFileOpened = true;
      return actual.open(path, flags, mode);
    });
    try {
      await expect(verifyBundleFiles(target, manifest())).rejects.toThrow('BUNDLE_FILE_UNAVAILABLE');
      expect(swapped).toBe(true);
      expect(outsideFileOpened).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  it('validates the manifest before opening any files', async () => {
    const value = manifest();
    value.files[0].path = '../outside';
    await expect(verifyBundleFiles(root, value)).rejects.toThrow();
  });
});

it.skipIf(process.platform === 'linux')('refuses verification without descriptor containment support', async () => {
  await expect(verifyBundleFiles('/unused', manifest())).rejects.toThrow('BUNDLE_REQUIRES_LINUX_CONTAINER');
});
