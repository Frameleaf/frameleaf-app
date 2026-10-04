import { vi } from 'vitest';
import { SystemMetadataKey } from 'src/enum.js';
import { LanDiscoveryService } from 'src/services/lan-discovery.service.js';
import * as frameleafRemoteAccess from 'src/utils/frameleaf-remote-access.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const publish = vi.fn();
const stop = vi.fn();
const unpublishAll = vi.fn();
const destroy = vi.fn();

vi.mock('bonjour-service', () => ({
  default: vi.fn().mockImplementation(function BonjourMock() {
    return { publish, unpublishAll, destroy };
  }),
}));

describe(LanDiscoveryService.name, () => {
  let sut: LanDiscoveryService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(LanDiscoveryService));
    publish.mockReset().mockReturnValue({ stop });
    stop.mockReset();
    unpublishAll.mockReset().mockImplementation((done: () => void) => done());
    destroy.mockReset().mockImplementation((done: () => void) => done());

    const env = mockEnvData({});
    mocks.config.getEnv.mockReturnValue({ ...env, port: 2283 });
    vi.spyOn(frameleafRemoteAccess, 'detectHostAddresses').mockReturnValue({
      lanAddresses: ['192.168.1.20'],
      ipv6Addresses: [],
    });
    mocks.systemMetadata.get.mockImplementation((key) => {
      if (key === SystemMetadataKey.FrameleafServerId) {
        return Promise.resolve({ id: 'server-1', createdAt: new Date().toISOString() } as never);
      }
      if (key === SystemMetadataKey.SystemConfig) {
        return Promise.resolve({ server: { name: 'My Server', lanDiscovery: true } } as never);
      }
      return Promise.resolve(null as never);
    });
  });

  describe('onBootstrap', () => {
    it('publishes _frameleaf._tcp when lanDiscovery is enabled', async () => {
      await sut.onBootstrap();

      expect(publish).toHaveBeenCalledWith({
        name: 'My Server',
        type: 'frameleaf',
        protocol: 'tcp',
        port: 2283,
        txt: { id: 'server-1', name: 'My Server', setup: 'needed', linked: 'false', cloud: 'unavailable' },
      });
    });

    it('advertises the FRAMELEAF_LOCAL_URL port behind a container port mapping (FL-218)', async () => {
      const env = mockEnvData({});
      mocks.config.getEnv.mockReturnValue({
        ...env,
        port: 2283,
        frameleafCloud: { ...env.frameleafCloud, localUrl: 'http://192.168.1.20:2290' },
      });

      await sut.onBootstrap();

      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ port: 2290 }));
    });

    it('says when setup is complete, and publishes again once the first administrator exists (FL-292)', async () => {
      await sut.onBootstrap();
      expect(publish.mock.calls[0][0].txt).toMatchObject({ setup: 'needed' });
      expect(JSON.stringify(publish.mock.calls[0][0].txt)).not.toMatch(/code/i);

      mocks.user.getAdmin.mockResolvedValue({ id: 'admin' } as never);
      await sut.onUserCreate({ isAdmin: true } as never);
      expect(stop).toHaveBeenCalled();
      expect(publish.mock.calls.at(-1)?.[0].txt).toMatchObject({ setup: 'complete' });
    });

    it('does not publish when lanDiscovery is disabled', async () => {
      mocks.systemMetadata.get.mockImplementation((key) => {
        if (key === SystemMetadataKey.SystemConfig) {
          return Promise.resolve({ server: { name: 'My Server', lanDiscovery: false } } as never);
        }
        return Promise.resolve(null as never);
      });

      await sut.onBootstrap();

      expect(publish).not.toHaveBeenCalled();
    });

    it('does not publish when this server has no LAN address to advertise on', async () => {
      vi.spyOn(frameleafRemoteAccess, 'detectHostAddresses').mockReturnValue({ lanAddresses: [], ipv6Addresses: [] });

      await sut.onBootstrap();

      expect(publish).not.toHaveBeenCalled();
    });
  });

  describe('onShutdown (FL-291)', () => {
    it('says goodbye before closing the socket, and publishes nothing afterwards', async () => {
      await sut.onBootstrap();
      await sut.onShutdown();

      expect(unpublishAll).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(unpublishAll.mock.invocationCallOrder[0]).toBeLessThan(destroy.mock.invocationCallOrder[0]);

      publish.mockClear();
      await sut.onConfigUpdate({ newConfig: { server: { lanDiscovery: true } } } as never);
      await sut.onUserCreate({ isAdmin: true } as never);
      expect(publish).not.toHaveBeenCalled();
    });

    it('does not wait on a socket that never answers', async () => {
      vi.useFakeTimers();
      onTestFinished(() => void vi.useRealTimers());
      unpublishAll.mockImplementation(() => {});
      destroy.mockImplementation(() => {});
      await sut.onBootstrap();
      const done = sut.onShutdown();
      await vi.advanceTimersByTimeAsync(2000);
      await expect(done).resolves.toBeUndefined();
    });

    it('is a no-op when nothing was published', async () => {
      await expect(sut.onShutdown()).resolves.toBeUndefined();
      expect(destroy).not.toHaveBeenCalled();
    });
  });

  describe('onConfigUpdate', () => {
    it('starts advertising once an admin turns lanDiscovery on', async () => {
      await sut.onConfigUpdate({ newConfig: { server: { lanDiscovery: true } } } as never);

      expect(publish).toHaveBeenCalledTimes(1);
    });

    it('stops advertising once an admin turns lanDiscovery off', async () => {
      await sut.onConfigUpdate({ newConfig: { server: { lanDiscovery: true } } } as never);
      await sut.onConfigUpdate({ newConfig: { server: { lanDiscovery: false } } } as never);

      expect(stop).toHaveBeenCalledTimes(1);
    });
  });
});
