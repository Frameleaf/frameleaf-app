import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder } from 'src/enum.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { ASSET_UPLOAD_LIMITS } from 'src/utils/asset-upload-resource.js';

it('caps new resources at half the actual writable volume and refuses declared excess before committing a URI', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'fl285-volume-'));
  const storage = { checkDiskUsage: vi.fn().mockResolvedValue({ available: 20, free: 100, total: 200 }) };
  const uploads = { create: vi.fn() };
  const service = new AssetUploadResourceService(
    uploads as never,
    { canUploadFile: vi.fn() } as never,
    {} as never,
    {} as never,
    storage as never,
    {} as never,
    { warn: vi.fn() } as never,
    {} as never,
    {} as never,
  );
  vi.spyOn(StorageCore, 'getBaseFolder').mockReturnValue(folder);
  vi.spyOn(service as unknown as { owner: (auth: AuthDto) => Promise<string> }, 'owner').mockResolvedValue('owner');
  const headers = {
    'upload-draft-interop-version': '9',
    'upload-complete': '?0',
    'upload-length': '11',
    'content-type': 'image/jpeg',
    'repr-digest': `sha-256=:${createHash('sha256').update('abcdefghijk').digest('base64')}:`,
    'asset-metadata': Buffer.from(
      JSON.stringify({
        filename: 'test.jpg',
        fileCreatedAt: new Date().toISOString(),
        fileModifiedAt: new Date().toISOString(),
      }),
    ).toString('base64url'),
  };
  const resume = vi.fn();
  try {
    expect(await service.limits()).toEqual({ ...ASSET_UPLOAD_LIMITS, maxSize: 10, maxAppendSize: 10 });
    expect(storage.checkDiskUsage).toHaveBeenCalledWith(folder);
    expect(StorageCore.getBaseFolder).toHaveBeenCalledWith(StorageFolder.Upload);
    await expect(
      service.create({ user: { id: 'owner' } } as AuthDto, headers, Readable.from([]), resume),
    ).rejects.toMatchObject({ status: 507 });
    expect(uploads.create).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    storage.checkDiskUsage.mockRejectedValueOnce(new Error('volume unavailable'));
    await expect(service.limits()).rejects.toMatchObject({ status: 503 });
    storage.checkDiskUsage.mockResolvedValue({ available: 0, free: 100, total: 200 });
    expect(await service.limits()).toMatchObject({ maxSize: 0, maxAppendSize: 0 });
  } finally {
    vi.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  }
});
