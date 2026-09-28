import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcmeClient, EdgeCertificateRepository } from 'src/edge/edge-certificate.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { automock } from 'test/utils.js';

/** Test-only self-signed certificates and keys (openssl, P-256), never used anywhere else. */
const FIXTURES = join(import.meta.dirname, '../../test/fixtures/frameleaf-edge');
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');

const NAMES = ['*.u225vlzhsdlhwh4l.frameleaf.net', 'u225vlzhsdlhwh4l.frameleaf.net'];
const ACCOUNT = 'https://acme.test/acme/acct/1';

/**
 * A fake ACME directory: one authorization per name, each with a DNS-01 challenge whose value is
 * derived from the name, a `valid` finalization and a fixed test certificate.
 */
const fakeCa = (certificate: string, options: { failValidation?: boolean } = {}) => {
  const calls: string[] = [];
  const orders: unknown[] = [];
  const client: AcmeClient = {
    createAccount: vi.fn(() => {
      calls.push('createAccount');
      return Promise.resolve({} as never);
    }),
    getAccountUrl: vi.fn(() => ACCOUNT),
    createOrder: vi.fn((data: unknown) => {
      calls.push('createOrder');
      orders.push(data);
      return Promise.resolve({ status: 'pending', identifiers: [], authorizations: [], finalize: '' } as never);
    }),
    getAuthorizations: vi.fn(() =>
      Promise.resolve(
        NAMES.map((name) => ({
          status: 'pending',
          identifier: { type: 'dns', value: name.replace('*.', '') },
          wildcard: name.startsWith('*.'),
          challenges: [
            { type: 'http-01', url: `http://${name}`, status: 'pending', token: 'x' },
            { type: 'dns-01', url: `dns://${name}`, status: 'pending', token: name },
          ],
        })) as never,
      ),
    ),
    getChallengeKeyAuthorization: vi.fn((challenge: { token: string }) =>
      Promise.resolve(Buffer.from(challenge.token.padEnd(32, '-')).toString('base64url').slice(0, 43)),
    ),
    completeChallenge: vi.fn(() => {
      calls.push('completeChallenge');
      return Promise.resolve({} as never);
    }),
    waitForValidStatus: vi.fn(() =>
      options.failValidation
        ? Promise.reject(new Error('DNS problem: NXDOMAIN looking up TXT for _acme-challenge'))
        : Promise.resolve({} as never),
    ),
    finalizeOrder: vi.fn(() => {
      calls.push('finalizeOrder');
      return Promise.resolve({ status: 'valid' } as never);
    }),
    getCertificate: vi.fn(() => Promise.resolve(certificate)),
  };
  return { client, calls, orders };
};

describe(EdgeCertificateRepository.name, () => {
  let sut: EdgeCertificateRepository;
  let identityDir: string;
  let certificate: string;
  let key: string;

  beforeEach(async () => {
    identityDir = await mkdtemp(join(tmpdir(), 'frameleaf-edge-'));
    certificate = await fixture('wildcard.cert.pem');
    key = await fixture('wildcard.key.pem');
    const logger = automock(LoggingRepository, { args: [undefined, { getEnv: () => ({}) }], strict: false });
    sut = new EdgeCertificateRepository(logger);
    vi.spyOn(sut, 'createCsr').mockResolvedValue({ key, csr: Buffer.from('csr') });
  });

  afterEach(async () => {
    await rm(identityDir, { recursive: true, force: true });
  });

  it('issues one wildcard order through DNS-01 and removes every challenge value again', async () => {
    const ca = fakeCa(certificate);
    vi.spyOn(sut, 'client').mockReturnValue(ca.client);
    const set: string[] = [];
    const removed: string[] = [];
    const onAccount = vi.fn(() => Promise.resolve());

    const result = await sut.issue(identityDir, {
      directoryUrl: 'https://acme.test/directory',
      names: NAMES,
      profile: 'tlsserver',
      onAccount,
      setChallenge: (value) => {
        set.push(value);
        return Promise.resolve();
      },
      removeChallenge: (value) => {
        removed.push(value);
        return Promise.resolve();
      },
    });

    expect(result).toEqual({ certificate, key, accountUrl: ACCOUNT });
    expect(onAccount).toHaveBeenCalledWith(ACCOUNT);
    expect(ca.orders).toEqual([{ identifiers: NAMES.map((value) => ({ type: 'dns', value })), profile: 'tlsserver' }]);
    // two values under one record (the wildcard and the bare label), both valid DNS-01 digests
    expect(set).toHaveLength(2);
    expect(set.every((value) => /^[\w-]{43}$/.test(value))).toBe(true);
    expect(removed).toEqual(set);
    expect(ca.calls).toEqual([
      'createAccount',
      'createOrder',
      'completeChallenge',
      'completeChallenge',
      'finalizeOrder',
    ]);
  });

  it('removes the challenge values when validation fails', async () => {
    const ca = fakeCa(certificate, { failValidation: true });
    vi.spyOn(sut, 'client').mockReturnValue(ca.client);
    const removed: string[] = [];
    await expect(
      sut.issue(identityDir, {
        directoryUrl: 'https://acme.test/directory',
        names: NAMES,
        setChallenge: () => Promise.resolve(),
        removeChallenge: (value) => {
          removed.push(value);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('NXDOMAIN');
    expect(removed).toHaveLength(2);
  });

  it('issues a custom hostname through the same challenge record (the delegated CNAME)', async () => {
    const custom = await fixture('custom.cert.pem');
    const ca = fakeCa(custom);
    ca.client.getAuthorizations = vi.fn(() =>
      Promise.resolve([
        {
          status: 'pending',
          identifier: { type: 'dns', value: 'photos.example.com' },
          challenges: [{ type: 'dns-01', url: 'dns://photos', status: 'pending', token: 'photos.example.com' }],
        },
      ] as never),
    );
    vi.spyOn(sut, 'client').mockReturnValue(ca.client);
    const set = vi.fn(() => Promise.resolve());
    const result = await sut.issue(identityDir, {
      directoryUrl: 'https://acme.test/directory',
      names: ['photos.example.com'],
      setChallenge: set,
      removeChallenge: () => Promise.resolve(),
    });
    expect(result.certificate).toBe(custom);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('keeps the account key, certificates and keys 0600 in a 0700 folder, and removes them', async () => {
    const accountKey = await sut.accountKey(identityDir);
    expect(accountKey).toContain('PRIVATE KEY');
    // the same account key on every call
    await expect(sut.accountKey(identityDir)).resolves.toBe(accountKey);

    await sut.write(identityDir, 'wildcard', { certificate, key });
    await expect(sut.read(identityDir, 'wildcard')).resolves.toEqual({ certificate, key });
    const dir = sut.directory(identityDir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    for (const file of ['acme-account.key.pem', 'wildcard.key.pem', 'wildcard.cert.pem']) {
      expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
    }

    await sut.remove(identityDir);
    await expect(sut.read(identityDir, 'wildcard')).resolves.toBeNull();
    // the ACME account key stays, so the CAA record keeps naming this server's account
    await expect(sut.accountKey(identityDir)).resolves.toBe(accountKey);
  });
});
