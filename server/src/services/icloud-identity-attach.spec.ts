import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ICloudAttachSchema } from 'src/dtos/icloud-identity.dto.js';
import { ICloudIdentityService } from 'src/services/icloud-identity.service.js';

const identifier = '32A01DD9-75DF-41B2-8773-80C153D73A5A:001:AQohY6yKZR0+tXlMi9FUQ82zySGo';
const auth = { user: { id: randomUUID() } } as unknown as AuthDto;
const item = () => ({
  id: 'original',
  assetId: randomUUID(),
  cloudIdentifier: identifier,
  role: 'original' as const,
  sha256: 'ab'.repeat(32),
});
const setup = (ownsDevice = true) => {
  const repository = {
    ownsDevice: vi.fn().mockResolvedValue(ownsDevice),
    attachDevice: vi.fn().mockResolvedValue(true),
  };
  const sut = new ICloudIdentityService(repository as never, {} as never, { setContext: vi.fn() } as never);
  return { sut, repository };
};

describe('iCloud identity attachment', () => {
  it('reports only successful attachments and gives unavailable assets the same answer', async () => {
    const { sut, repository } = setup();
    const original = item();
    const unavailable = { ...item(), id: 'unavailable' };
    repository.attachDevice.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const deviceKey = randomUUID();
    expect(
      await sut.attach(auth, {
        deviceKey,
        items: [original, unavailable, { ...item(), id: 'invalid', cloudIdentifier: 'opaque' }],
      }),
    ).toEqual({
      items: [
        { id: 'original', state: 'attached' },
        { id: 'unavailable', state: 'unavailable' },
        { id: 'invalid', state: 'invalid' },
      ],
    });
    expect(repository.attachDevice).toHaveBeenCalledTimes(2);
    expect(repository.attachDevice).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({
        ownerId: auth.user.id,
        assetId: original.assetId,
        sha256: Buffer.from(original.sha256, 'hex'),
        deviceKey,
        claimId: null,
      }),
    );
  });

  it('refuses an unregistered or foreign device before recording any identity', async () => {
    const { sut, repository } = setup(false);
    await expect(sut.attach(auth, { deviceKey: randomUUID(), items: [item()] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repository.attachDevice).not.toHaveBeenCalled();
  });

  it('validates digests, bounds batches and requires the version for an edit render', () => {
    const input = { deviceKey: randomUUID(), items: [item()] };
    expect(ICloudAttachSchema.safeParse(input).success).toBe(true);
    for (const patch of [{ sha256: 'short' }, { assetId: 'other' }, { role: 'edit-render' }]) {
      expect(ICloudAttachSchema.safeParse({ ...input, items: [{ ...item(), ...patch }] }).success).toBe(false);
    }
    expect(ICloudAttachSchema.safeParse({ ...input, items: [] }).success).toBe(false);
    expect(ICloudAttachSchema.safeParse({ ...input, items: Array.from({ length: 501 }, item) }).success).toBe(false);
    expect(
      ICloudAttachSchema.parse({ ...input, items: [{ ...item(), sha256: 'AB'.repeat(32) }] }).items[0].sha256,
    ).toBe('ab'.repeat(32));
  });
});
