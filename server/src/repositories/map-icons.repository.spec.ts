import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import { MapRepository } from 'src/repositories/map.repository.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const body = (id: string) =>
  gzipSync(JSON.stringify({ id, background: '#102030', tile: true, png: 'iVBORw0KGgo=' }) + '\n');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const repository = () =>
  new MapRepository(
    { getEnv: () => ({ resourcePaths: { geodata: { landmarkIcons: '/nonexistent' } } }) } as never,
    undefined as never,
    { setContext: () => {} } as never,
    undefined as never,
  );

describe('landmark icon publication', () => {
  let media: string;
  beforeEach(() => {
    media = mkdtempSync(join(tmpdir(), 'landmark-publication-'));
    StorageCore.setMediaLocation(media);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    StorageCore.reset();
    rmSync(media, { recursive: true, force: true });
  });

  it('installs concurrently without sharing staging files', async () => {
    const bytes = body('Q243');
    const { promise: bothRequested, resolve: release } = Promise.withResolvers<void>();
    let requests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (++requests === 2) release();
        await bothRequested;
        return new Response(bytes);
      }),
    );
    const pack = { url: 'https://static.frameleaf.cloud/pack', sha256: sha256(bytes) };
    await expect(
      Promise.all([repository().installLandmarkIcons(pack), repository().installLandmarkIcons(pack)]),
    ).resolves.toEqual([true, true]);
    expect(repository().getLandmarkIcons().has('Q243')).toBe(true);
    expect(readFileSync(repository().getLandmarkIconPath('Q243')!)).toEqual(Buffer.from('iVBORw0KGgo=', 'base64'));
  });

  it('keeps the last good pack if publication fails, and keeps old reader paths after an upgrade', async () => {
    const sut = repository();
    const original = body('Q243');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(original))),
    );
    await sut.installLandmarkIcons({ url: 'https://static.frameleaf.cloud/pack', sha256: sha256(original) });
    const oldPath = realpathSync(sut.getLandmarkIconPath('Q243')!);
    const updated = body('Q181185');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(updated))),
    );
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const rename = vi
      .mocked(fs.rename)
      .mockImplementationOnce(actual.rename)
      .mockRejectedValueOnce(new Error('publish failed'));
    await expect(
      sut.installLandmarkIcons({ url: 'https://static.frameleaf.cloud/pack', sha256: sha256(updated) }),
    ).rejects.toThrow('publish failed');
    expect(sut.getLandmarkIcons().has('Q243')).toBe(true);
    expect(readFileSync(oldPath)).toEqual(Buffer.from('iVBORw0KGgo=', 'base64'));
    rename.mockClear();
    await sut.installLandmarkIcons({ url: 'https://static.frameleaf.cloud/pack', sha256: sha256(updated) });
    expect(sut.getLandmarkIcons().has('Q181185')).toBe(true);
    expect(readFileSync(oldPath)).toEqual(Buffer.from('iVBORw0KGgo=', 'base64'));
  });
});
