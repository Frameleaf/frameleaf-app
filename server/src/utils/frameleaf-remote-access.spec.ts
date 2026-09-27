import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FrameleafRemoteEnrollment } from 'src/types.js';
import { discoveryRemoteProblem, discoverySchema } from 'src/utils/frameleaf-cloud.js';
import {
  DEFAULT_DIRECT_DOMAIN,
  addressOfName,
  buildCandidates,
  certificateFacts,
  certificateMatchesKey,
  certificateReport,
  challengeRecordName,
  classifyArrival,
  customHostnameRecords,
  directDomainOf,
  dnsTxtPutResponseSchema,
  enrollResponseSchema,
  enrollmentProblem,
  heartbeatEndpoints,
  hostAddresses,
  hostnameProblem,
  hostnameStatus,
  ipv4Name,
  ipv6Name,
  nextRenewalCheck,
  normalizeSerial,
  remoteEndpoints,
  remoteHostnameListSchema,
  remoteLabel,
  remotePublicUrl,
  renewalDue,
  retryDelayMs,
  validateCustomHostname,
  wildcardNames,
} from 'src/utils/frameleaf-remote-access.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

// the instance the cloud's remote fixtures were made for (`remote/label-vectors.json`, first vector)
const INSTANCE_ID = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';
const DAY = 24 * 60 * 60 * 1000;

const enrollment = (): FrameleafRemoteEnrollment => {
  const answer = enrollResponseSchema.parse(cloudContractFixture('remote/enroll-response.json'));
  return { ...answer, cloudUrl: 'https://frameleaf.cloud.test', instanceId: INSTANCE_ID, enrolledAt: '' };
};

/** Test-only self-signed certificates (openssl, P-256), never used anywhere else. */
const testCertificate = (name: 'wildcard' | 'custom') =>
  readFileSync(join(import.meta.dirname, '../../test/fixtures/frameleaf-edge', `${name}.cert.pem`), 'utf8');

const settings = (overrides: Partial<Parameters<typeof buildCandidates>[0]['settings']> = {}) => ({
  mode: 'relay' as 'relay' | 'relay-and-direct',
  directPort: 2443,
  publicUrl: 'frameleaf' as 'frameleaf' | 'custom',
  customHostname: { host: '', status: 'pending' as 'pending' | 'verified' },
  ...overrides,
});

describe('frameleaf remote access (FL-165)', () => {
  describe('label', () => {
    it('matches every golden vector the cloud publishes', () => {
      const { vectors } = cloudContractFixture<{ vectors: Array<{ instanceId: string; label: string }> }>(
        'remote/label-vectors.json',
      );
      expect(vectors.length).toBeGreaterThan(0);
      for (const vector of vectors) {
        expect(remoteLabel(vector.instanceId)).toBe(vector.label);
        expect(remoteLabel(vector.instanceId.toUpperCase())).toBe(vector.label);
      }
    });
  });

  describe('enrolment', () => {
    it('reads the published enrolment answer and takes its direct domain from it', () => {
      const answer = enrollResponseSchema.parse(cloudContractFixture('remote/enroll-response.json'));
      expect(enrollmentProblem(INSTANCE_ID, answer)).toBeNull();
      expect(answer.domain).toBe('frameleaf.net');
      expect(directDomainOf(answer, { remote: { directDomain: 'frameleaf.example' } })).toBe('frameleaf.net');
      expect(wildcardNames(answer)).toEqual(['*.u225vlzhsdlhwh4l.frameleaf.net', 'u225vlzhsdlhwh4l.frameleaf.net']);
      expect(challengeRecordName(answer)).toBe('_acme-challenge.u225vlzhsdlhwh4l');
    });

    it('takes the direct domain from discovery before enrolment, and frameleaf.net only as the default', () => {
      const golden = cloudContractFixture('instance/discovery.json');
      // the cloud's published discovery names its direct domain (frameleaf-cloud daa22f6)
      expect(directDomainOf(null, discoverySchema.parse(golden))).toBe(golden.remote.directDomain);
      const other = discoverySchema.parse({ ...golden, remote: { directDomain: 'direct.example' } });
      expect(directDomainOf(null, other)).toBe('direct.example');
      const older = discoverySchema.parse({ ...golden, remote: undefined });
      expect(directDomainOf(null, older)).toBe(DEFAULT_DIRECT_DOMAIN);
      expect(DEFAULT_DIRECT_DOMAIN).toBe('frameleaf.net');
      // a bad remote block is dropped, never fails discovery
      const bad = discoverySchema.parse({ ...golden, remote: { directDomain: 'not a domain' } });
      expect(bad.remote).toBeUndefined();
    });

    it('builds every name under the zone discovery provides: the cloud dev and test zones and a delegated subdomain', () => {
      for (const zone of [
        'frameleaf.net',
        'frameleaf-direct.localhost',
        'frameleaf-direct.test',
        'direct.example.com',
      ]) {
        const document = discoverySchema.parse({
          ...cloudContractFixture<object>('instance/discovery.json'),
          remote: { directDomain: zone },
        });
        const domain = directDomainOf(null, document);
        expect(domain).toBe(zone);
        const names = { label: 'u225vlzhsdlhwh4l', domain };
        expect(wildcardNames(names)).toEqual([`*.u225vlzhsdlhwh4l.${zone}`, `u225vlzhsdlhwh4l.${zone}`]);
        expect(customHostnameRecords('photos.example.com', names)[0].value).toBe(`r.u225vlzhsdlhwh4l.${zone}`);
      }
    });

    it('falls back to frameleaf.net when discovery gives no zone, or one that is not a lowercase domain name', () => {
      const golden = cloudContractFixture('instance/discovery.json');
      for (const directDomain of [
        '',
        'Frameleaf.NET',
        'frameleaf.net.',
        '.frameleaf.net',
        'frameleaf..net',
        '*.frameleaf.net',
        'frameleaf',
        'https://frameleaf.net',
        `${'a'.repeat(64)}.net`,
        `${'a.'.repeat(126)}net`,
        'frame_leaf.net',
        '-frameleaf.net',
      ]) {
        const document = discoverySchema.parse({ ...golden, remote: { directDomain } });
        expect(document.remote, directDomain).toBeUndefined();
        expect(discoveryRemoteProblem({ ...golden, remote: { directDomain } })).toContain('remote.directDomain');
        expect(directDomainOf(null, document)).toBe('frameleaf.net');
      }
      expect(directDomainOf(null, discoverySchema.parse({ ...golden, remote: 'frameleaf.net' }))).toBe('frameleaf.net');
      expect(directDomainOf(null, null)).toBe('frameleaf.net');
      expect(discoveryRemoteProblem(golden)).toBeNull();
      expect(discoveryRemoteProblem({ ...golden, remote: undefined })).toBeNull();
    });

    it('refuses an answer for another server or with names its label does not make', () => {
      const answer = enrollResponseSchema.parse(cloudContractFixture('remote/enroll-response.json'));
      expect(enrollmentProblem('01930000-0000-7000-8000-000000000000', answer)).toBe(
        'the enrolment is for another server',
      );
      expect(
        enrollmentProblem(INSTANCE_ID, { ...answer, names: { ...answer.names, relay: 'r.attacker.example.com' } }),
      ).toBe('the enrolment names do not match its label');
      expect(
        enrollmentProblem(INSTANCE_ID, {
          ...answer,
          domain: 'frameleaf.cloud',
          names: {
            relay: `r.${answer.label}.frameleaf.cloud`,
            // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- the contract's placeholder
            lanPattern: `{ipv4}.${answer.label}.frameleaf.cloud`,
            // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- the contract's placeholder
            ipv6Pattern: `{ipv6}.${answer.label}.frameleaf.cloud`,
          },
        }),
      ).toBe('the direct domain is not a per-server domain');
    });

    it('builds the endpoints from discovery', () => {
      const endpoints = remoteEndpoints({ api: 'https://api.frameleaf.cloud.test/' });
      expect(endpoints.enroll).toBe('https://api.frameleaf.cloud.test/v1/remote/enroll');
      expect(endpoints.dnsTxt).toBe('https://api.frameleaf.cloud.test/v1/remote/dns/txt');
      expect(endpoints.hostname('photos.example.com')).toBe(
        'https://api.frameleaf.cloud.test/v1/remote/hostnames/photos.example.com',
      );
    });
  });

  describe('DNS TXT and certificate reports', () => {
    it('sends the TXT write exactly as the contract publishes it and reads its answer', () => {
      const request = cloudContractFixture<{ name: string; value: string }>('remote/dns-txt-put-request.json');
      expect({ name: challengeRecordName(enrollment()), value: request.value }).toEqual(request);
      expect(dnsTxtPutResponseSchema.parse(cloudContractFixture('remote/dns-txt-put-response.json'))).toMatchObject({
        propagated: true,
      });
    });

    it('reports a certificate with the facts the contract names, and nothing else', () => {
      const report = certificateReport({
        names: ['*.u225vlzhsdlhwh4l.frameleaf.net', 'u225vlzhsdlhwh4l.frameleaf.net'],
        serial: normalizeSerial('04:1f:9a:7c:2e:55:0b:13:77:aa:c0:de:12:34:56:78:9a:bc'),
        issuer: "C=US, O=Let's Encrypt, CN=R11",
        notBefore: '2026-09-25T16:00:00.000Z',
        notAfter: '2026-11-09T16:00:00.000Z',
      });
      const fixture = cloudContractFixture('remote/certs-request.json');
      expect(Object.keys(report)).toEqual(Object.keys(fixture));
      expect({ ...report, serial: normalizeSerial(fixture.serial) }).toEqual({
        ...fixture,
        serial: normalizeSerial(fixture.serial),
      });
    });

    it('reads a certificate’s names, serial, issuer and validity in one line', () => {
      const facts = certificateFacts(testCertificate('wildcard'));
      expect(facts.names).toEqual(wildcardNames(enrollment()));
      expect(facts.serial).toMatch(/^[\da-f]+$/);
      expect(facts.issuer).not.toMatch(/\n/);
      expect(Date.parse(facts.notAfter)).toBeGreaterThan(Date.parse(facts.notBefore));
    });
  });

  describe('renewal and retries', () => {
    const certificate = (days: number, lifetimeDays = 45) => ({
      notBefore: new Date(Date.UTC(2026, 8, 1)).toISOString(),
      notAfter: new Date(Date.UTC(2026, 8, 1) + lifetimeDays * DAY).toISOString(),
      now: Date.UTC(2026, 8, 1) + (lifetimeDays - days) * DAY,
    });

    it('renews once less than 25 days, or a third of the lifetime, is left', () => {
      const early = certificate(26);
      expect(renewalDue(early, early.now)).toBe(false);
      const due = certificate(24);
      expect(renewalDue(due, due.now)).toBe(true);
      // a 90-day certificate renews with 30 days left (a third of its lifetime)
      const long = certificate(29, 90);
      expect(renewalDue(long, long.now)).toBe(true);
      const longEarly = certificate(31, 90);
      expect(renewalDue(longEarly, longEarly.now)).toBe(false);
    });

    it('checks daily with up to six hours of jitter', () => {
      const now = Date.UTC(2026, 8, 1);
      expect(Date.parse(nextRenewalCheck(now, () => 0)) - now).toBe(DAY);
      expect(Date.parse(nextRenewalCheck(now, () => 0.99)) - now).toBeLessThan(DAY + 6 * 60 * 60 * 1000);
    });

    it('retries after 1 h, doubling up to 24 h', () => {
      const hour = 60 * 60 * 1000;
      expect([1, 2, 3, 4, 5, 6, 7, 20].map((failures) => retryDelayMs(failures) / hour)).toEqual([
        1, 2, 4, 8, 16, 24, 24, 24,
      ]);
    });
  });

  describe('custom hostnames', () => {
    it('accepts a subdomain the administrator owns, as the prototype does', () => {
      expect(validateCustomHostname(' Photos.Example.com. ')).toEqual({
        valid: true,
        host: 'photos.example.com',
        message: '',
      });
    });

    it.each([
      ['', 'Enter a hostname such as photos.example.com.'],
      ['https://photos.example.com', 'Enter only the hostname, without https:// or a path.'],
      ['photos.example.com/app', 'Enter only the hostname, without https:// or a path.'],
      ['example.com', 'Use a subdomain you own, such as photos.example.com.'],
      ['192.168.1.10', 'Use a subdomain you own, such as photos.example.com.'],
      ['bad_label.example.com', 'Use a subdomain you own, such as photos.example.com.'],
      ['photos.frameleaf.net', 'Use a domain you own; Frameleaf addresses are already set up.'],
      ['r.u225vlzhsdlhwh4l.frameleaf.net', 'Use a domain you own; Frameleaf addresses are already set up.'],
      ['id.frameleaf.cloud', 'Use a domain you own; Frameleaf addresses are already set up.'],
    ])('refuses %j', (value, message) => {
      expect(validateCustomHostname(value)).toMatchObject({ valid: false, message });
    });

    it('refuses names under the direct domain in use, whatever it is', () => {
      expect(validateCustomHostname('photos.direct.example', 'direct.example')).toMatchObject({ valid: false });
    });

    it('shows the two records the cloud publishes for the hostname', () => {
      const { hostnames } = remoteHostnameListSchema.parse(cloudContractFixture('remote/hostnames-list.json'));
      const [pending, verified] = hostnames;
      const records = customHostnameRecords(pending.hostname, enrollment());
      expect(records.map(({ type, name, value }) => ({ type, name, value }))).toEqual(pending.records);
      expect(hostnameStatus(pending.state)).toBe('pending');
      expect(hostnameStatus(verified.state)).toBe('verified');
      expect(hostnameStatus('failing')).toBe('verified');
      expect(hostnameStatus('failed')).toBe('pending');
      expect(hostnameProblem({ state: 'pending', failureReason: 'cname_missing' })).toContain('CNAME');
      expect(hostnameProblem({ state: 'pending', failureReason: null })).toBeNull();
    });

    it('sends the hostname exactly as the contract publishes it', () => {
      const request = cloudContractFixture<{ hostname: string }>('remote/hostname-put-request.json');
      expect({ hostname: validateCustomHostname(request.hostname).host }).toEqual(request);
    });
  });

  describe('public URL and candidates', () => {
    it('publishes the relay name, or the verified custom hostname when chosen', () => {
      const names = enrollment();
      expect(remotePublicUrl(null, settings())).toBeNull();
      expect(remotePublicUrl(names, settings())).toBe('https://r.u225vlzhsdlhwh4l.frameleaf.net');
      const pending = settings({
        publicUrl: 'custom',
        customHostname: { host: 'photos.example.com', status: 'pending' },
      });
      expect(remotePublicUrl(names, pending)).toBe('https://r.u225vlzhsdlhwh4l.frameleaf.net');
      const verified = settings({
        publicUrl: 'custom',
        customHostname: { host: 'photos.example.com', status: 'verified' },
      });
      expect(remotePublicUrl(names, verified)).toBe('https://photos.example.com');
    });

    it('orders candidates local, wan, ipv6, custom, relay and publishes direct ones only in direct mode', () => {
      const names = enrollment();
      const input = {
        enrollment: names,
        listenPort: 2443,
        lanAddresses: ['192.168.1.10', '8.8.8.8'],
        ipv6Addresses: ['2001:db8::1', 'fd00::5', 'fe80::1'],
        publicIpv4: '203.0.113.7',
        ipv6Listening: true,
      };
      const relayOnly = buildCandidates({ ...input, settings: settings() });
      expect(relayOnly.map((candidate) => [candidate.kind, candidate.uri])).toEqual([
        ['local', 'https://192-168-1-10.u225vlzhsdlhwh4l.frameleaf.net:2443'],
        ['relay', 'https://r.u225vlzhsdlhwh4l.frameleaf.net'],
      ]);

      const direct = buildCandidates({
        ...input,
        settings: settings({
          mode: 'relay-and-direct',
          directPort: 4443,
          customHostname: { host: 'photos.example.com', status: 'verified' },
        }),
      });
      expect(direct.map((candidate) => [candidate.kind, candidate.uri, candidate.custom])).toEqual([
        ['local', 'https://192-168-1-10.u225vlzhsdlhwh4l.frameleaf.net:2443', false],
        ['wan', 'https://203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:4443', false],
        // IPv6 has no router mapping: the listener's own port
        ['ipv6', 'https://2001-db8--1.u225vlzhsdlhwh4l.frameleaf.net:2443', false],
        ['wan', 'https://photos.example.com', true],
        ['relay', 'https://r.u225vlzhsdlhwh4l.frameleaf.net', false],
      ]);
      expect(direct.every((candidate) => candidate.httpsRequired && candidate.protocol === 'https')).toBe(true);
      expect(heartbeatEndpoints(direct).map((endpoint) => endpoint.kind)).toEqual([
        'local',
        'wan',
        'ipv6',
        'custom',
        'relay',
      ]);
    });
  });

  describe('arrivals', () => {
    const names = enrollment();
    const lanName = ipv4Name(names, '192.168.1.10');

    it('encodes and decodes the per-server names', () => {
      expect(lanName).toBe('192-168-1-10.u225vlzhsdlhwh4l.frameleaf.net');
      expect(ipv6Name(names, '2001:0db8:0000::0001')).toBe('2001-db8--1.u225vlzhsdlhwh4l.frameleaf.net');
      expect(addressOfName(names, lanName)).toBe('192.168.1.10');
      expect(addressOfName(names, '2001-db8--1.u225vlzhsdlhwh4l.frameleaf.net')).toBe('2001:db8::1');
      expect(addressOfName(names, 'r.u225vlzhsdlhwh4l.frameleaf.net')).toBeNull();
      expect(addressOfName(names, '192-168-1-10.otherlabel.frameleaf.net')).toBeNull();
    });

    it('tags lan only for an advertised LAN name asked by a peer on its subnet', () => {
      const classify = (
        peer: string,
        servername: string | null,
        options: { trustedLanCidrs?: string[]; advertised?: string[]; gateways?: string[] } = {},
      ) =>
        classifyArrival({
          peer,
          servername,
          enrollment: names,
          trustedLanCidrs: options.trustedLanCidrs ?? [],
          advertised: options.advertised ?? ['192.168.1.10'],
          gateways: options.gateways ?? [],
        });
      expect(classify('192.168.1.20', lanName)).toBe('lan');
      expect(classify('::ffff:192.168.1.20', lanName)).toBe('lan');
      // a public peer is never lan, whatever name it asks for
      expect(classify('203.0.113.9', lanName)).toBe('wan');
      // a home peer on another subnet (a proxy, another network) is not lan
      expect(classify('10.0.0.5', lanName)).toBe('wan');
      // the SNI is the client's choice: a name this server never advertised proves nothing
      expect(classify('192.168.1.20', '192-168-1-99.u225vlzhsdlhwh4l.frameleaf.net')).toBe('wan');
      expect(classify('192.168.1.20', lanName, { advertised: [] })).toBe('wan');
      // the relay name, a public address's name or no name is wan
      expect(classify('192.168.1.20', 'r.u225vlzhsdlhwh4l.frameleaf.net')).toBe('wan');
      expect(classify('192.168.1.20', '203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net')).toBe('wan');
      expect(classify('192.168.1.20', null)).toBe('wan');
      // behind Docker's userland proxy every visitor comes from the gateway: wan unless trusted by name
      expect(classify('192.168.1.1', lanName, { gateways: ['192.168.1.1'] })).toBe('wan');
      const trustedGateway = { gateways: ['192.168.1.1'], trustedLanCidrs: ['192.168.1.1/32'] };
      expect(classify('192.168.1.1', lanName, trustedGateway)).toBe('lan');
      // a loopback peer is never lan
      expect(classify('127.0.0.1', ipv4Name(names, '127.0.0.1'), { advertised: ['127.0.0.1'] })).toBe('wan');
      // IPv6: the same /64
      const ulaName = ipv6Name(names, 'fd00::10');
      expect(classify('fd00::20', ulaName, { advertised: ['fd00::10'] })).toBe('lan');
      expect(classify('fd00:1::20', ulaName, { advertised: ['fd00::10'] })).toBe('wan');
      // FRAMELEAF_TRUSTED_LAN_CIDRS trusts peers explicitly (a tailnet)
      const tailnetName = '100-64-0-1.u225vlzhsdlhwh4l.frameleaf.net';
      expect(classify('100.64.9.5', tailnetName, { advertised: ['100.64.0.1'] })).toBe('wan');
      const tailnet = { advertised: ['100.64.0.1'], trustedLanCidrs: ['100.64.0.0/10'] };
      expect(classify('100.64.9.5', tailnetName, tailnet)).toBe('lan');
    });

    it('advertises only FRAMELEAF_LOCAL_URL in a container, and never a bridge interface', () => {
      const interfaces = [
        { name: 'eth0', address: '192.168.1.10', family: 'IPv4' as const, internal: false },
        { name: 'eth0', address: '2001:db8::10', family: 'IPv6' as const, internal: false },
        { name: 'docker0', address: '172.17.0.1', family: 'IPv4' as const, internal: false },
        { name: 'br-5f2c', address: '172.18.0.1', family: 'IPv4' as const, internal: false },
        { name: 'lo', address: '127.0.0.1', family: 'IPv4' as const, internal: true },
      ];
      const none = { lanAddresses: [], ipv6Addresses: [] };
      // in a container: a hostname (or no) FRAMELEAF_LOCAL_URL advertises nothing, never the bridge
      const container = { interfaces, defaultInterfaces: ['eth0'], inContainer: true };
      // eslint-disable-next-line unicorn/prefer-https -- a LAN address is plain http
      expect(hostAddresses({ ...container, localUrl: 'http://photos.home.arpa:2283' })).toEqual(none);
      expect(hostAddresses({ ...container, localUrl: null })).toEqual(none);
      expect(hostAddresses({ ...container, localUrl: 'http://192.168.1.10:2283' })).toEqual({
        lanAddresses: ['192.168.1.10'],
        ipv6Addresses: [],
      });
      // bare metal: the default-route interface only
      const host = { interfaces, inContainer: false, localUrl: null };
      expect(hostAddresses({ ...host, defaultInterfaces: ['eth0'] })).toEqual({
        lanAddresses: ['192.168.1.10'],
        ipv6Addresses: ['2001:db8::10'],
      });
      // a bridge is never advertised, even when a default route uses it
      expect(hostAddresses({ ...host, defaultInterfaces: ['docker0', 'br-5f2c'] })).toEqual(none);
    });

    it('checks that a certificate and its key belong together', () => {
      const dir = join(import.meta.dirname, '../../test/fixtures/frameleaf-edge');
      const wildcardKey = readFileSync(join(dir, 'wildcard.key.pem'), 'utf8');
      const customKey = readFileSync(join(dir, 'custom.key.pem'), 'utf8');
      expect(certificateMatchesKey(testCertificate('wildcard'), wildcardKey)).toBe(true);
      expect(certificateMatchesKey(testCertificate('wildcard'), customKey)).toBe(false);
      expect(certificateMatchesKey(testCertificate('wildcard'), 'not a key')).toBe(false);
    });
  });
});
