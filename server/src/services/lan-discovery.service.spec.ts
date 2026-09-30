import { vi } from 'vitest';
import { SystemMetadataKey } from 'src/enum.js';
import { LanDiscoveryService } from 'src/services/lan-discovery.service.js';
import * as frameleafRemoteAccess from 'src/utils/frameleaf-remote-access.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const publish = vi.fn();
const stop = vi.fn();

vi.mock('bonjour-service', () => ({
  default: vi.fn().mockImplementation(function BonjourMock() {
    return { publish };
  }),
}));

describe(LanDiscoveryService.name, () => {
  let sut: LanDiscoveryService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(LanDiscoveryService));
    publish.mockReset().mockReturnValue({ stop });
    stop.mockReset();

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
        txt: { id: 'server-1', name: 'My Server' },
      });
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
