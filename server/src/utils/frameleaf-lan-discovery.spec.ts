import { localConnectionCandidates } from 'src/utils/frameleaf-lan-discovery.js';

describe('localConnectionCandidates', () => {
  it('builds one unverified, plain-HTTP local candidate per address, on this server’s own port', () => {
    const candidates = localConnectionCandidates({ port: 2283, addresses: ['192.168.1.10', '10.0.0.5'] });
    expect(candidates).toEqual([
      {
        kind: 'local',
        uri: 'http://192.168.1.10:2283',
        protocol: 'http',
        address: '192.168.1.10',
        port: 2283,
        local: true,
        relay: false,
        ipv6: false,
        custom: false,
        dnsRebindingProtection: false,
        httpsRequired: false,
        verified: false,
      },
      {
        kind: 'local',
        uri: 'http://10.0.0.5:2283',
        protocol: 'http',
        address: '10.0.0.5',
        port: 2283,
        local: true,
        relay: false,
        ipv6: false,
        custom: false,
        dnsRebindingProtection: false,
        httpsRequired: false,
        verified: false,
      },
    ]);
  });

  it('uses FRAMELEAF_LOCAL_URL’s scheme and port for the address it names (FL-218)', () => {
    const [mapped, other] = localConnectionCandidates({
      port: 2283,
      addresses: ['192.168.1.10', '10.0.0.5'],
      localUrl: 'http://192.168.1.10:2290',
    });
    expect(mapped).toMatchObject({ uri: 'http://192.168.1.10:2290', port: 2290, protocol: 'http' });
    expect(other).toMatchObject({ uri: 'http://10.0.0.5:2283', port: 2283 });

    const [secure] = localConnectionCandidates({
      port: 2283,
      addresses: ['192.168.1.10'],
      localUrl: 'https://192.168.1.10',
    });
    expect(secure).toMatchObject({
      uri: 'https://192.168.1.10:443',
      protocol: 'https',
      port: 443,
      httpsRequired: true,
    });
  });

  it('returns nothing when there are no addresses to advertise', () => {
    expect(localConnectionCandidates({ port: 2283, addresses: [] })).toEqual([]);
  });
});
