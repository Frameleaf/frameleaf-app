import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DevelopStyleService } from 'src/services/develop-style.service.js';
import { equivalentDesktopModelKeys } from 'src/utils/desktop-model-equivalents.js';
import { factory } from 'test/small.factory.js';

describe(DevelopStyleService.name, () => {
  const build = () => {
    const styles = { getProfile: vi.fn(), shootPhotos: vi.fn(), trainingPhotos: vi.fn().mockResolvedValue([]) };
    const decode = vi.fn();
    const search = { getEmbedding: vi.fn() };
    const createStyleVersion = vi.fn();
    const service = new DevelopStyleService(
      styles as never,
      { decodeImage: decode } as never,
      search as never,
      { getActive: vi.fn().mockResolvedValue(undefined) } as never,
      { createStyleVersion } as never,
      { styleAlbumId: vi.fn().mockResolvedValue('owned-album') } as never,
      { setContext: vi.fn() } as never,
    );
    return { service, styles, decode, createStyleVersion, search };
  };

  it('requires a user session before reading any training data', async () => {
    const { service, styles } = build();
    await expect(service.get({ ...factory.auth(), session: undefined })).rejects.toBeInstanceOf(ForbiddenException);
    expect(styles.trainingPhotos).not.toHaveBeenCalled();
  });

  it('rejects a selection that contains an unavailable or non-shoot asset before rendering', async () => {
    const { service, styles, decode, createStyleVersion } = build();
    const auth = { ...factory.auth(), session: { hasElevatedPermission: false } as never };
    styles.getProfile.mockResolvedValue({ modelJson: {} });
    styles.shootPhotos.mockResolvedValue([{ id: 'photo-1', path: '/preview.jpg' }]);
    await expect(
      service.apply(auth, 'shoot-1', { batchId: 'batch-1', assetIds: ['photo-1', 'photo-2'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(styles.shootPhotos).toHaveBeenCalledWith(auth.user.id, 'owned-album', ['photo-1', 'photo-2']);
    expect(decode).not.toHaveBeenCalled();
    expect(createStyleVersion).not.toHaveBeenCalled();
  });

  it('uses a photo vector stored under another key of the same encoder, and no other', async () => {
    const profiles: { modelKey: string; workload: string }[] = JSON.parse(
      readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8'),
    ).profiles;
    const [keyA, keyB] = profiles
      .filter((profile) => profile.workload === 'clip')
      .map((profile) => equivalentDesktopModelKeys(profile.modelKey))
      .find((family) => family.length > 1)!;
    const { service, decode, search } = build();
    decode.mockResolvedValue({ data: Buffer.alloc(96 * 96 * 3), info: { channels: 3 } });
    const features = (key: string) =>
      (
        service as unknown as {
          features: (photo: { id: string; path: string }, key: string) => Promise<{ embedding?: number[] }>;
        }
      ).features({ id: 'photo-1', path: '/preview.jpg' }, key);
    search.getEmbedding.mockResolvedValue({ embedding: '[1,0]', producerModelKey: keyB });
    expect((await features(keyA)).embedding).toBeDefined();
    search.getEmbedding.mockResolvedValue({ embedding: '[1,0]', producerModelKey: `clip:${'0'.repeat(64)}` });
    expect((await features(keyA)).embedding).toBeUndefined();
  });
});
