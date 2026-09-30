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

  it('returns nothing when there are no addresses to advertise', () => {
    expect(localConnectionCandidates({ port: 2283, addresses: [] })).toEqual([]);
  });
});
