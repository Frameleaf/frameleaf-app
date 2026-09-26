import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FrameleafRemoteEnrollment } from 'src/types.js';
import { discoverySchema } from 'src/utils/frameleaf-cloud.js';
import {
  DEFAULT_DIRECT_DOMAIN,
  addressOfName,
  buildCandidates,
  certificateFacts,
  certificateReport,
  challengeRecordName,
  classifyArrival,
  customHostnameRecords,
  directDomainOf,
  dnsTxtPutResponseSchema,
  enrollResponseSchema,
  enrollmentProblem,
  heartbeatEndpoints,
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
      expect(answer.domain).toBe('frameleaf-direct.net');
      expect(directDomainOf(answer, { remote: { directDomain: 'frameleaf.net' } })).toBe('frameleaf-direct.net');
      expect(wildcardNames(answer)).toEqual([
        '*.u225vlzhsdlhwh4l.frameleaf-direct.net',
        'u225vlzhsdlhwh4l.frameleaf-direct.net',
      ]);
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
            lanPattern: `{ipv4}.${answer.label}.frameleaf.cloud`,
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
        names: ['*.u225vlzhsdlhwh4l.frameleaf-direct.net', 'u225vlzhsdlhwh4l.frameleaf-direct.net'],
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
      ['r.u225vlzhsdlhwh4l.frameleaf-direct.net', 'Use a domain you own; Frameleaf addresses are already set up.'],
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
      expect(remotePublicUrl(names, settings())).toBe('https://r.u225vlzhsdlhwh4l.frameleaf-direct.net');
      const pending = settings({
        publicUrl: 'custom',
        customHostname: { host: 'photos.example.com', status: 'pending' },
      });
      expect(remotePublicUrl(names, pending)).toBe('https://r.u225vlzhsdlhwh4l.frameleaf-direct.net');
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
      };
      const relayOnly = buildCandidates({ ...input, settings: settings() });
      expect(relayOnly.map((candidate) => [candidate.kind, candidate.uri])).toEqual([
        ['local', 'https://192-168-1-10.u225vlzhsdlhwh4l.frameleaf-direct.net:2443'],
        ['relay', 'https://r.u225vlzhsdlhwh4l.frameleaf-direct.net'],
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
        ['local', 'https://192-168-1-10.u225vlzhsdlhwh4l.frameleaf-direct.net:2443', false],
        ['wan', 'https://203-0-113-7.u225vlzhsdlhwh4l.frameleaf-direct.net:4443', false],
        ['ipv6', 'https://2001-db8--1.u225vlzhsdlhwh4l.frameleaf-direct.net:4443', false],
        ['wan', 'https://photos.example.com', true],
        ['relay', 'https://r.u225vlzhsdlhwh4l.frameleaf-direct.net', false],
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
      expect(lanName).toBe('192-168-1-10.u225vlzhsdlhwh4l.frameleaf-direct.net');
      expect(ipv6Name(names, '2001:0db8:0000::0001')).toBe('2001-db8--1.u225vlzhsdlhwh4l.frameleaf-direct.net');
      expect(addressOfName(names, lanName)).toBe('192.168.1.10');
      expect(addressOfName(names, '2001-db8--1.u225vlzhsdlhwh4l.frameleaf-direct.net')).toBe('2001:db8::1');
      expect(addressOfName(names, 'r.u225vlzhsdlhwh4l.frameleaf-direct.net')).toBeNull();
      expect(addressOfName(names, '192-168-1-10.otherlabel.frameleaf-direct.net')).toBeNull();
    });

    it('tags a home peer asking for a home LAN name as lan, everything else as wan', () => {
      const classify = (peer: string, servername: string | null, trustedLanCidrs: string[] = []) =>
        classifyArrival({ peer, servername, enrollment: names, trustedLanCidrs });
      expect(classify('192.168.1.20', lanName)).toBe('lan');
      expect(classify('::ffff:192.168.1.20', lanName)).toBe('lan');
      expect(classify('fd00::20', lanName)).toBe('lan');
      // a public peer is never lan, whatever name it asks for
      expect(classify('203.0.113.9', lanName)).toBe('wan');
      // a home peer asking for the relay name, a public address's name or no name is wan
      expect(classify('192.168.1.20', 'r.u225vlzhsdlhwh4l.frameleaf-direct.net')).toBe('wan');
      expect(classify('192.168.1.20', '203-0-113-7.u225vlzhsdlhwh4l.frameleaf-direct.net')).toBe('wan');
      expect(classify('192.168.1.20', null)).toBe('wan');
      // FRAMELEAF_TRUSTED_LAN_CIDRS widens both the peer and the name
      expect(classify('100.64.0.5', '100-64-0-1.u225vlzhsdlhwh4l.frameleaf-direct.net')).toBe('wan');
      const tailnetName = '100-64-0-1.u225vlzhsdlhwh4l.frameleaf-direct.net';
      expect(classify('100.64.0.5', tailnetName, ['100.64.0.0/10'])).toBe('lan');
    });
  });
});
