import { BadRequestException } from '@nestjs/common';
import { BaseService } from 'src/services/base.service.js';
import { ClusterGroupFactory } from 'test/factories/cluster-group.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { newTestService } from 'test/utils.js';

describe('inactive imported-account creation', () => {
  it('discards source authentication material and administrative role before provisioning', async () => {
    const { sut, mocks } = newTestService(BaseService);
    const user = UserFactory.create({ importClaimPending: true });
    mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
    mocks.clusterGroup.create.mockResolvedValue(ClusterGroupFactory.create({ id: user.clusterGroupId }));
    mocks.user.create.mockResolvedValue(user);
    await sut.createUser({
      id: user.id,
      name: user.name,
      email: user.email,
      importClaimPending: true,
      isAdmin: true,
      password: 'source-password-hash',
      pinCode: 'source-pin-hash',
      oauthId: 'source-subject',
      passwordLinkHash: Buffer.from('source-link-hash'),
      passwordLinkExpiresAt: new Date('2027-01-01'),
    });
    expect(mocks.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: user.id,
        email: user.email,
        importClaimPending: true,
        isAdmin: false,
        password: null,
        pinCode: null,
        oauthId: null,
        passwordLinkHash: null,
        passwordLinkExpiresAt: null,
        shouldChangePassword: false,
      }),
    );
    expect(mocks.crypto.hashBcrypt).not.toHaveBeenCalled();
  });
  it('refuses an email collision instead of adopting an existing account', async () => {
    const { sut, mocks } = newTestService(BaseService);
    const existing = UserFactory.create();
    mocks.user.getByEmail.mockResolvedValue(existing);
    await expect(
      sut.createUser({ email: existing.email, name: 'Source owner', importClaimPending: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.user.create).not.toHaveBeenCalled();
    expect(mocks.user.update).not.toHaveBeenCalled();
  });
  it('requires an existing administrator even if the source calls its owner an administrator', async () => {
    const { sut, mocks } = newTestService(BaseService);
    await expect(
      sut.createUser({ email: 'mapped@example.test', name: 'Source owner', isAdmin: true, importClaimPending: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.user.create).not.toHaveBeenCalled();
  });
});
