import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DevelopStyleService } from 'src/services/develop-style.service.js';
import { factory } from 'test/small.factory.js';

describe(DevelopStyleService.name, () => {
  const build = () => {
    const styles = { getProfile: vi.fn(), shootPhotos: vi.fn(), trainingPhotos: vi.fn().mockResolvedValue([]) };
    const decode = vi.fn();
    const createStyleVersion = vi.fn();
    const service = new DevelopStyleService(
      styles as never,
      { decodeImage: decode } as never,
      {} as never,
      { getActive: vi.fn().mockResolvedValue(undefined) } as never,
      { createStyleVersion } as never,
      { styleAlbumId: vi.fn().mockResolvedValue('owned-album') } as never,
      { setContext: vi.fn() } as never,
    );
    return { service, styles, decode, createStyleVersion };
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
});
