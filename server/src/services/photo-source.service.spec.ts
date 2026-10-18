import { randomUUID } from 'node:crypto';
import { PhotoSourceService } from 'src/services/photo-source.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';

vi.mock('src/utils/access.js', () => ({ requireAccess: vi.fn().mockResolvedValue(undefined) }));

describe('photo source verification admission', () => {
  it.each(['2026-10-16 20:00:00+00', undefined])('refunds only its identified window (%s)', async (windowExpiresAt) => {
    const limits = {
      hit: vi.fn().mockResolvedValue({ count: 2, resetSeconds: 900, windowExpiresAt }),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const id = randomUUID();
    const service = new PhotoSourceService(
      { target: vi.fn().mockResolvedValue({ assetId: id }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      limits as never,
      { warn: vi.fn() } as never,
    );
    await expect(service.verify(authStub.user1, id, id, id, { uploadResourceId: id })).rejects.toThrow(
      'photo_source_verification_busy',
    );
    if (windowExpiresAt) {
      expect(limits.release).toHaveBeenCalledExactlyOnceWith('photo-source-verify:user-id', windowExpiresAt);
    } else {
      expect(limits.release).not.toHaveBeenCalled();
    }
  });
});
