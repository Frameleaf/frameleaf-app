import {
  EdgePortMappingService,
  MAPPING_LEASE_SEC,
  MAPPING_REFRESH_MS,
  MAPPING_RETRY_MS,
  type MappingGateway,
} from 'src/edge/edge-port-mapping.service.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { tryPromise } from 'src/utils/promise.js';
import { automock } from 'test/utils.js';

const fakeGateway = (method: MappingGateway['method'], options: { refuse?: string; ip?: string } = {}) => {
  const gateway = {
    method,
    map: vi.fn((_internalPort: number, _host: string, externalPort: number) =>
      options.refuse ? Promise.reject(new Error(options.refuse)) : Promise.resolve(externalPort),
    ),
    unmap: vi.fn(() => Promise.resolve()),
    externalIp: vi.fn(() => Promise.resolve(options.ip ?? '203.0.113.7')),
    stop: vi.fn(() => Promise.resolve()),
  };
  return gateway satisfies MappingGateway;
};

describe(EdgePortMappingService.name, () => {
  let sut: EdgePortMappingService;
  const now = Date.UTC(2026, 8, 26, 12);
  const input = { internalHost: '192.168.1.10', internalPort: 2443, externalPort: 2443, now };

  beforeEach(() => {
    const logger = automock(LoggingRepository, { args: [undefined, { getEnv: () => ({}) }], strict: false });
    sut = new EdgePortMappingService(logger);
    sut.routers = () => ['192.168.1.1'];
  });

  it('maps the direct port by UPnP first, with a one-hour lease', async () => {
    const upnp = fakeGateway('upnp');
    const pmp = fakeGateway('nat-pmp');
    sut.findUpnp = () => Promise.resolve(upnp);
    sut.natPmp = vi.fn(() => pmp);
    const status = await sut.keep(input);
    expect(upnp.map).toHaveBeenCalledWith(2443, '192.168.1.10', 2443, MAPPING_LEASE_SEC);
    expect(sut.natPmp).not.toHaveBeenCalled();
    expect(status).toEqual({
      method: 'upnp',
      externalPort: 2443,
      externalIp: '203.0.113.7',
      leaseUntil: new Date(now + 3600 * 1000).toISOString(),
      error: null,
      noGateway: false,
    });
  });

  it('falls back to NAT-PMP on the default gateway when UPnP finds nothing', async () => {
    const pmp = fakeGateway('nat-pmp');
    sut.findUpnp = () => Promise.resolve(null);
    sut.natPmp = vi.fn(() => pmp);
    const status = await sut.keep(input);
    expect(sut.natPmp).toHaveBeenCalledWith('192.168.1.1');
    expect(status.method).toBe('nat-pmp');
  });

  it('falls back to NAT-PMP when the UPnP router refuses', async () => {
    const upnp = fakeGateway('upnp', { refuse: 'ConflictInMappingEntry' });
    sut.findUpnp = () => Promise.resolve(upnp);
    sut.natPmp = () => fakeGateway('nat-pmp');
    expect((await sut.keep(input)).method).toBe('nat-pmp');
    expect(upnp.stop).toHaveBeenCalled();
  });

  it('renews the lease every 30 minutes on the same router', async () => {
    const upnp = fakeGateway('upnp');
    const find = vi.fn(() => Promise.resolve(upnp));
    sut.findUpnp = find;
    await sut.keep(input);
    await sut.keep({ ...input, now: now + MAPPING_REFRESH_MS - 1 });
    expect(upnp.map).toHaveBeenCalledTimes(1);
    const renewed = await sut.keep({ ...input, now: now + MAPPING_REFRESH_MS });
    expect(upnp.map).toHaveBeenCalledTimes(2);
    expect(find).toHaveBeenCalledTimes(1);
    expect(renewed.leaseUntil).toBe(new Date(now + MAPPING_REFRESH_MS + 3600 * 1000).toISOString());
  });

  it('unmaps when released, and maps again after a port change', async () => {
    const first = fakeGateway('upnp');
    const second = fakeGateway('upnp');
    sut.findUpnp = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await sut.keep(input);
    await sut.keep({ ...input, externalPort: 3443 });
    expect(first.unmap).toHaveBeenCalledWith(2443);
    expect(first.stop).toHaveBeenCalled();
    expect(second.map).toHaveBeenCalledWith(2443, '192.168.1.10', 3443, MAPPING_LEASE_SEC);
    await sut.release();
    expect(second.unmap).toHaveBeenCalledWith(2443);
    expect(sut.status.method).toBeNull();
  });

  it('reports that no router answered, and tries again after 5 minutes', async () => {
    const find = vi.fn(() => Promise.resolve(null));
    sut.findUpnp = find;
    sut.natPmp = () => fakeGateway('nat-pmp', { refuse: 'timed out' });
    const status = await sut.keep(input);
    expect(status).toMatchObject({ method: null, noGateway: true, error: 'NAT-PMP: timed out' });
    await sut.keep({ ...input, now: now + MAPPING_RETRY_MS - 1 });
    expect(find).toHaveBeenCalledTimes(1);
    await sut.keep({ ...input, now: now + MAPPING_RETRY_MS });
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('says a router answered when it refused the mapping', async () => {
    sut.findUpnp = () => Promise.resolve(fakeGateway('upnp', { refuse: 'not allowed' }));
    sut.routers = () => [];
    expect(await sut.keep(input)).toMatchObject({ noGateway: false, error: 'UPnP: not allowed' });
  });

  it('keeps no external address the router made up', async () => {
    sut.findUpnp = () => Promise.resolve(fakeGateway('upnp', { ip: 'not an address' }));
    expect((await sut.keep(input)).externalIp).toBeNull();
  });

  it.each(['discovery', 'mapping', 'address', 'renewal'])(
    'discards late %s completion after release',
    async (stage) => {
      const gateway = fakeGateway('upnp');
      sut.findUpnp = vi.fn().mockResolvedValue(gateway);
      if (stage === 'renewal') await sut.keep(input);
      const started = Promise.withResolvers<void>();
      const discovery = Promise.withResolvers<MappingGateway>();
      const mapping = Promise.withResolvers<number>();
      const address = Promise.withResolvers<string>();
      if (stage === 'discovery')
        sut.findUpnp = vi.fn(() => {
          started.resolve();
          return discovery.promise;
        });
      else if (stage === 'address')
        gateway.externalIp.mockImplementation(() => {
          started.resolve();
          return address.promise;
        });
      else
        gateway.map.mockImplementation(() => {
          started.resolve();
          return mapping.promise;
        });
      const pending = sut.keep({ ...input, now: stage === 'renewal' ? now + MAPPING_REFRESH_MS : now });
      await started.promise;
      await sut.release();
      discovery.resolve(gateway);
      mapping.resolve(2443);
      address.resolve('203.0.113.7');
      const result = await pending;
      expect(result).toMatchObject({ method: null, externalPort: null, error: null });
      expect(sut.status).toEqual(result);
      expect(gateway.stop).toHaveBeenCalled();
      if (stage === 'discovery') expect(gateway.map).not.toHaveBeenCalled();
      else expect(gateway.unmap).toHaveBeenCalledWith(2443);
      if (stage === 'renewal') expect(gateway.unmap).toHaveBeenCalledTimes(1);
      else if (stage === 'mapping') expect(gateway.externalIp).not.toHaveBeenCalled();
    },
  );

  it('does not start a fallback after released discovery finds no UPnP router', async () => {
    const found = Promise.withResolvers<MappingGateway | null>();
    sut.findUpnp = () => found.promise;
    sut.natPmp = vi.fn(() => fakeGateway('nat-pmp'));
    const pending = sut.keep(input);
    await sut.release();
    found.resolve(null);
    expect((await pending).method).toBeNull();
    expect(sut.natPmp).not.toHaveBeenCalled();
  });

  it('does not resume a port change released during old mapping removal, and permits a later keep', async () => {
    const first = fakeGateway('upnp');
    const next = fakeGateway('upnp');
    sut.findUpnp = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(next);
    await sut.keep(input);
    const started = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    first.unmap.mockImplementation(() => {
      started.resolve();
      return removed.promise;
    });
    const pending = sut.keep({ ...input, externalPort: 3443 });
    await started.promise;
    await sut.release();
    removed.resolve();
    expect((await pending).method).toBeNull();
    expect(sut.findUpnp).toHaveBeenCalledTimes(1);
    expect(next.map).not.toHaveBeenCalled();
    expect((await sut.keep({ ...input, externalPort: 3443 })).method).toBe('upnp');
    expect(sut.findUpnp).toHaveBeenCalledTimes(2);
  });

  it('does not start a fallback when release occurs while a failed gateway is stopping', async () => {
    const gateway = fakeGateway('upnp', { refuse: 'mapping refused' });
    const stopping = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    gateway.stop.mockImplementation(() => {
      stopping.resolve();
      return stopped.promise;
    });
    sut.findUpnp = () => Promise.resolve(gateway);
    sut.natPmp = vi.fn(() => fakeGateway('nat-pmp'));
    const pending = sut.keep(input);
    await stopping.promise;
    await sut.release();
    stopped.resolve();
    expect((await pending).method).toBeNull();
    expect(sut.natPmp).not.toHaveBeenCalled();
  });

  it('does not publish or impose retry delay after a released mapping later rejects', async () => {
    const first = fakeGateway('upnp');
    const next = fakeGateway('upnp');
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<number>();
    first.map.mockImplementation(() => {
      started.resolve();
      return result.promise;
    });
    sut.findUpnp = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(next);
    sut.natPmp = vi.fn(() => fakeGateway('nat-pmp'));
    const pending = sut.keep(input);
    await started.promise;
    await sut.release();
    result.reject(new Error('late timeout'));
    expect(await pending).toMatchObject({ method: null, error: null });
    expect(sut.natPmp).not.toHaveBeenCalled();
    expect((await sut.keep(input)).method).toBe('upnp');
    expect(sut.findUpnp).toHaveBeenCalledTimes(2);
  });

  it('still stops a late gateway and stays released when removing its confirmed lease fails', async () => {
    const gateway = fakeGateway('upnp');
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<number>();
    gateway.map.mockImplementation(() => {
      started.resolve();
      return result.promise;
    });
    gateway.unmap.mockRejectedValue(new Error('router removal refused'));
    sut.findUpnp = () => Promise.resolve(gateway);
    const pending = sut.keep(input);
    await started.promise;
    await sut.release();
    result.resolve(2443);
    expect((await pending).method).toBeNull();
    expect(gateway.unmap).toHaveBeenCalledWith(2443);
    expect(gateway.stop).toHaveBeenCalled();
    expect(sut.status.method).toBeNull();
  });

  it.each(['renewal success', 'renewal failure', 'renewal address'])(
    'keeps the transport usable for cleanup after release during %s',
    async (stage) => {
      const gateway = fakeGateway('nat-pmp');
      sut.findUpnp = () => Promise.resolve(gateway);
      await sut.keep(input);
      const started = Promise.withResolvers<void>();
      const mapping = Promise.withResolvers<number>();
      const address = Promise.withResolvers<string>();
      let stopped = false;
      let removed = false;
      gateway.stop.mockImplementation(() =>
        tryPromise(() => {
          stopped = true;
        }),
      );
      gateway.unmap.mockImplementation(() =>
        tryPromise(() => {
          if (stopped) throw new Error('socket closed');
          removed = true;
        }),
      );
      if (stage === 'renewal address') {
        gateway.externalIp.mockImplementation(() => {
          started.resolve();
          return address.promise;
        });
      } else {
        gateway.map.mockImplementation(() => {
          started.resolve();
          return mapping.promise;
        });
      }
      const pending = sut.keep({ ...input, now: now + MAPPING_REFRESH_MS });
      await started.promise;
      await sut.release();
      const stoppedBeforeCompletion = stopped;
      if (stage === 'renewal failure') mapping.reject(new Error('renewal refused'));
      else mapping.resolve(2443);
      address.resolve('203.0.113.7');
      expect((await pending).method).toBeNull();
      expect(stoppedBeforeCompletion).toBe(false);
      expect(removed).toBe(true);
      expect(stopped).toBe(true);
      expect(gateway.unmap).toHaveBeenCalledExactlyOnceWith(2443);
      expect(gateway.stop).toHaveBeenCalledTimes(1);
    },
  );

  it('removes the last confirmed lease before stopping a router that refuses renewal', async () => {
    const gateway = fakeGateway('upnp');
    sut.findUpnp = () => Promise.resolve(gateway);
    await sut.keep(input);
    gateway.map.mockRejectedValueOnce(new Error('renewal refused'));
    expect((await sut.keep({ ...input, now: now + MAPPING_REFRESH_MS })).method).toBeNull();
    expect(gateway.unmap).toHaveBeenCalledExactlyOnceWith(2443);
    expect(gateway.unmap.mock.invocationCallOrder[0]).toBeLessThan(gateway.stop.mock.invocationCallOrder[0]);
    await sut.release();
    expect(gateway.unmap).toHaveBeenCalledTimes(1);
  });
});
