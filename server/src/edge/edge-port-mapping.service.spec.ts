import {
  EdgePortMappingService,
  MAPPING_LEASE_SEC,
  MAPPING_REFRESH_MS,
  MAPPING_RETRY_MS,
  type MappingGateway,
} from 'src/edge/edge-port-mapping.service.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
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
});
