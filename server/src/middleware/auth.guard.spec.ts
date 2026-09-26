import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, Authenticated, OriginalTransfer } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AuthService } from 'src/services/auth.service.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

class TestController {
  @Authenticated({ public: true, setup: true })
  setupRoute() {}

  @Authenticated({ public: true })
  publicRoute() {}

  undecoratedRoute() {}

  @Authenticated()
  @OriginalTransfer()
  originalRoute() {}

  @Authenticated()
  thumbnailRoute() {}
}

const contextFor = (handler: () => void, request: Record<string, unknown> = {}) =>
  ({
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ headers: {}, query: {}, path: '/', ...request }) }),
  }) as unknown as ExecutionContext;

describe(AuthGuard.name, () => {
  let sut: AuthGuard;
  let authService: AuthService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut: authService, mocks } = newTestService(AuthService));
    sut = new AuthGuard(mocks.logger as unknown as LoggingRepository, new Reflector(), authService);
  });

  describe('setup routes', () => {
    it('should allow access while the server is awaiting its first admin', async () => {
      mocks.user.hasAdmin.mockResolvedValue(false);
      const authenticate = vitest.spyOn(authService, 'authenticate');

      await expect(sut.canActivate(contextFor(TestController.prototype.setupRoute))).resolves.toBe(true);

      expect(authenticate).not.toHaveBeenCalled();
    });

    it('should reject when setup is disabled', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ setup: { allow: false } }));
      mocks.user.hasAdmin.mockResolvedValue(false);

      await expect(sut.canActivate(contextFor(TestController.prototype.setupRoute))).rejects.toThrowError(
        'Admin setup is not available',
      );
    });

    it('should reject when the server already has an admin', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);

      await expect(sut.canActivate(contextFor(TestController.prototype.setupRoute))).rejects.toThrowError(
        'Admin setup is not available',
      );
    });
  });

  describe('public routes', () => {
    it('should not require setup availability', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);

      await expect(sut.canActivate(contextFor(TestController.prototype.publicRoute))).resolves.toBe(true);
    });
  });

  describe('undecorated routes', () => {
    it('should be rejected', async () => {
      const authenticate = vitest.spyOn(authService, 'authenticate');

      await expect(sut.canActivate(contextFor(TestController.prototype.undecoratedRoute))).rejects.toThrowError(
        'does not declare @Authenticated()',
      );

      expect(authenticate).not.toHaveBeenCalled();
    });
  });

  describe('remote access (FL-161)', () => {
    it('passes how the request arrived to authentication', async () => {
      const authenticate = vitest.spyOn(authService, 'authenticate').mockResolvedValue({} as never);

      await sut.canActivate(contextFor(TestController.prototype.thumbnailRoute, { frameleafVia: 'relay' }));

      expect(authenticate).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ via: 'relay' }) }),
      );
    });

    it('checks an original transfer against the relay rule, and nothing else', async () => {
      vitest.spyOn(authService, 'authenticate').mockResolvedValue({} as never);
      const requireOriginalTransfer = vitest.spyOn(authService, 'requireOriginalTransfer').mockResolvedValue();

      await sut.canActivate(contextFor(TestController.prototype.thumbnailRoute, { frameleafVia: 'relay' }));
      expect(requireOriginalTransfer).not.toHaveBeenCalled();

      await sut.canActivate(
        contextFor(TestController.prototype.originalRoute, { frameleafVia: 'relay', path: '/api/assets/1/original' }),
      );
      expect(requireOriginalTransfer).toHaveBeenCalledWith('relay', '/api/assets/1/original');
    });

    it('refuses an original over the relay by default', async () => {
      vitest.spyOn(authService, 'authenticate').mockResolvedValue({} as never);
      mocks.systemMetadata.get.mockResolvedValue(null as never);

      await expect(
        sut.canActivate(contextFor(TestController.prototype.originalRoute, { frameleafVia: 'relay' })),
      ).rejects.toThrow('not available through the Frameleaf relay');
      await expect(
        sut.canActivate(contextFor(TestController.prototype.originalRoute, { frameleafVia: 'wan' })),
      ).resolves.toBe(true);
      await expect(sut.canActivate(contextFor(TestController.prototype.originalRoute))).resolves.toBe(true);
    });
  });
});
