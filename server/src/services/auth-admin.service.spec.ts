import { AuthAdminService } from 'src/services/auth-admin.service.js';
import { systemConfigStub } from 'test/fixtures/system-config.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(AuthAdminService.name, () => {
  let sut: AuthAdminService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AuthAdminService));
  });

  describe('checkOAuthProvider (FL-367)', () => {
    it('says what the provider answered', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.check.mockResolvedValue({ issuer: 'https://accounts.example.test' });

      await expect(
        sut.checkOAuthProvider({ issuerUrl: 'https://accounts.example.test', clientId: 'frameleaf' }),
      ).resolves.toEqual({ ok: true, issuer: 'https://accounts.example.test', error: null });
      expect(mocks.oauth.check).toHaveBeenCalledWith(
        expect.objectContaining({ issuerUrl: 'https://accounts.example.test', clientId: 'frameleaf' }),
      );
    });

    it('says why the provider did not answer', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.check.mockRejectedValue(
        new Error('Error in OAuth discovery', { cause: new Error('getaddrinfo ENOTFOUND') }),
      );

      await expect(
        sut.checkOAuthProvider({ issuerUrl: 'https://nowhere.example.test', clientId: 'frameleaf' }),
      ).resolves.toEqual({ ok: false, issuer: null, error: 'getaddrinfo ENOTFOUND' });
    });
  });
});
