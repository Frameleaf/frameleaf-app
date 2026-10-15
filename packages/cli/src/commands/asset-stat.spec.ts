import { AssetUploadAction, checkBulkUpload } from '@frameleaf/sdk';
import { statSync, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { checkForDuplicates, deleteFiles, findSidecar, uploadFiles } from 'src/commands/asset';
import { hashFile } from 'src/utils';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  checkBulkUpload: vi.fn(),
}));
vi.mock('src/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils')>()),
  hashFile: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  stat: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  statSync: vi.fn(),
}));

describe('upload metadata admission', () => {
  beforeEach(() => {
    vi.mocked(statSync).mockReset();
    vi.mocked(fs.unlink).mockReset().mockResolvedValue();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads metadata concurrently within the upload limit and retains input order', async () => {
    const gates = [Promise.withResolvers<Stats>(), Promise.withResolvers<Stats>(), Promise.withResolvers<Stats>()];
    vi.mocked(fs.stat)
      .mockReset()
      .mockImplementation((file) => gates[Number(file)].promise);
    const pending = uploadFiles(['0', '1', '2'], { concurrency: 2, dryRun: true });
    await vi.waitFor(() => expect(fs.stat).toHaveBeenCalledTimes(2));
    gates[1].resolve({ size: 20 } as Stats);
    expect(fs.stat).toHaveBeenCalledTimes(2);
    gates[0].resolve({ size: 10 } as Stats);
    await vi.waitFor(() => expect(fs.stat).toHaveBeenCalledTimes(3));
    gates[2].resolve({ size: 30 } as Stats);
    await expect(pending).resolves.toEqual(['0', '1', '2'].map((filepath) => ({ filepath, id: '' })));
  });

  it('fails before any upload request when metadata is unavailable', async () => {
    const failure = new Error('file disappeared');
    vi.mocked(fs.stat).mockReset().mockRejectedValue(failure);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(uploadFiles(['missing'], { concurrency: 2 })).rejects.toBe(failure);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('bounds duplicate-check metadata reads and admits hashing only after all metadata succeeds', async () => {
    const gates = [Promise.withResolvers<Stats>(), Promise.withResolvers<Stats>(), Promise.withResolvers<Stats>()];
    vi.mocked(fs.stat)
      .mockReset()
      .mockImplementation((file) => gates[Number(file)].promise);
    vi.mocked(hashFile).mockReset().mockResolvedValue({ sha1: 'legacy', sha256: 'current' });
    vi.mocked(checkBulkUpload).mockImplementation(async ({ assetBulkUploadCheckDto: { assets } }) => ({
      results: assets.map(({ id }) => ({ id, action: AssetUploadAction.Accept })),
    }));
    const pending = checkForDuplicates(['0', '1', '2'], { concurrency: 2 });
    await vi.waitFor(() => expect(fs.stat).toHaveBeenCalledTimes(2));
    gates[1].resolve({ size: 20 } as Stats);
    expect(hashFile).not.toHaveBeenCalled();
    expect(fs.stat).toHaveBeenCalledTimes(2);
    gates[0].resolve({ size: 10 } as Stats);
    await vi.waitFor(() => expect(fs.stat).toHaveBeenCalledTimes(3));
    expect(hashFile).not.toHaveBeenCalled();
    gates[2].resolve({ size: 30 } as Stats);
    await expect(pending).resolves.toEqual({ newFiles: ['0', '1', '2'], duplicates: [] });
    expect(checkBulkUpload).toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: ['0', '1', '2'].flatMap((id) => [
          { id, checksum: 'current' },
          { id, checksum: 'legacy' },
        ]),
      },
    });
  });

  it('does not hash or contact the server if duplicate-check metadata fails', async () => {
    const failure = new Error('metadata unavailable');
    vi.mocked(fs.stat).mockReset().mockRejectedValue(failure);
    vi.mocked(hashFile).mockClear();
    vi.mocked(checkBulkUpload).mockClear();
    await expect(checkForDuplicates(['missing'], { concurrency: 2 })).rejects.toBe(failure);
    expect(hashFile).not.toHaveBeenCalled();
    expect(checkBulkUpload).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'EIO'])('does not silently omit a selected sidecar after %s', async (code) => {
    const failure = Object.assign(new Error('sidecar unavailable'), { code });
    vi.mocked(statSync).mockReturnValue({ size: 3 } as Stats);
    vi.mocked(fs.stat)
      .mockReset()
      .mockImplementation(async (file) => {
        if (file === 'photo.jpg') {
          return { size: 10, mtime: new Date('2022-01-01T00:00:00Z') } as Stats;
        }
        throw failure;
      });
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 'asset', status: 'created' }, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(uploadFiles(['photo.jpg'], { concurrency: 1 })).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still tolerates a selected sidecar disappearing before its upload stat', async () => {
    vi.mocked(statSync).mockReturnValue({ size: 3 } as Stats);
    vi.mocked(fs.stat)
      .mockReset()
      .mockImplementation(async (file) => {
        if (file === 'photo.jpg') {
          return { size: 10, mtime: new Date('2022-01-01T00:00:00Z') } as Stats;
        }
        throw Object.assign(new Error('sidecar disappeared'), { code: 'ENOENT' });
      });
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 'asset', status: 'created' }, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(uploadFiles(['photo.jpg'], { concurrency: 1 })).resolves.toEqual([
      { id: 'asset', filepath: 'photo.jpg' },
    ]);
    const form = fetch.mock.calls[0][1].body as FormData;
    expect(form.has('sidecarData')).toBe(false);
    expect(form.get('fileCreatedAt')).toBe(form.get('fileModifiedAt'));
  });

  it('propagates sidecar lookup errors instead of reporting absence', () => {
    const failure = Object.assign(new Error('cannot inspect sidecar'), { code: 'EACCES' });
    vi.mocked(statSync).mockImplementation(() => {
      throw failure;
    });
    expect(() => findSidecar('photo.jpg')).toThrow(failure);
  });

  it('preserves every original when sidecar discovery fails before deletion', async () => {
    const failure = Object.assign(new Error('cannot inspect sidecar'), { code: 'EIO' });
    vi.mocked(statSync).mockImplementation((file) => {
      throw String(file).startsWith('photo2') ? failure : Object.assign(new Error('no sidecar'), { code: 'ENOENT' });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      deleteFiles(
        [
          { id: 'asset1', filepath: 'photo1.jpg' },
          { id: 'asset2', filepath: 'photo2.jpg' },
        ],
        [],
        { concurrency: 1, delete: true },
      ),
    ).rejects.toBe(failure);
    expect(fs.unlink).not.toHaveBeenCalled();
  });
});
