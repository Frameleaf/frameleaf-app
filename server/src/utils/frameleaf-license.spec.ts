import { describe, expect, it } from 'vitest';
import type { FrameleafLicense, FrameleafLicenseClaims } from 'src/types.js';
import { FRAMELEAF_LICENSE_KEYS } from 'src/constants.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import {
  BUNDLED_PRICING,
  LicenseSigningKey,
  acceptPublishedPricing,
  certificateKind,
  checkLicenseKey,
  comparePricing,
  effectivePricing,
  entitlementFlags,
  isLicensed,
  licenseStatus,
  nextRefreshAt,
  verifyLicenseCertificate,
} from 'src/utils/frameleaf-license.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { makeLicenseSigner, signLicenseCertificate } from 'test/fixtures/frameleaf-license.fixture.js';

/**
 * Whether an unlinked server's signed activation (`application/jose`, FL-177 as-built decision #28)
 * is one Frameleaf Cloud would accept: the header must carry the public key it is signed with, whose
 * RFC 7638 thumbprint is the header's own `kid`, and the payload's `fingerprint.jkt` must name that
 * same key. This mirrors the cloud's own check (`activateWithCloud`'s counterpart), not app code —
 * the app only ever builds this JWS with `InstanceIdentityRepository.signJwsWithPublicKey`, which
 * always derives `kid` and `fingerprint.jkt` from the one signing key, so it can never disagree with
 * itself the way these golden mismatch fixtures do on purpose.
 */
const activationJoseProblem = (
  header: { kid?: unknown; jwk?: { kty: string; crv: string; x: string } },
  payload: { fingerprint: { jkt?: unknown } },
): 'missing-jwk' | 'kid-mismatch' | 'jkt-mismatch' | null => {
  if (!header.jwk) {
    return 'missing-jwk';
  }
  if (ed25519Thumbprint(header.jwk) !== header.kid) {
    return 'kid-mismatch';
  }
  return payload.fingerprint.jkt === header.kid ? null : 'jkt-mismatch';
};

const active = makeLicenseSigner('active');
const spare = makeLicenseSigner('spare');
const stranger = makeLicenseSigner('active');
const keys = [active.key, spare.key];

const NOW = Date.UTC(2026, 8, 25, 12);
const nowSeconds = NOW / 1000;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const signCertificate = (
  privateKey: typeof active.privateKey,
  kid: string,
  claims: Partial<FrameleafLicenseClaims> & Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) => signLicenseCertificate({ privateKey, key: { ...active.key, kid } }, nowSeconds, claims, header);

const context = { keys, instanceId: 'instance-1', accountId: 'account-1', now: NOW };

const stored = (claims: Partial<FrameleafLicenseClaims>): FrameleafLicense => ({
  certificate: 'x',
  kind: 'plan',
  source: 'account',
  kid: active.key.kid,
  claims: {
    iss: 'i',
    aud: 'frameleaf-server',
    sub: 'account-1',
    iid: 'instance-1',
    ent: ['CLOUD', 'REMOTE_ACCESS', 'CLOUD_BACKUP', 'CLOUD_ML'],
    lic_exp: nowSeconds + 86_400,
    grace_days: 7,
    iat: nowSeconds - 86_400,
    exp: nowSeconds + 6 * 86_400,
    ...claims,
  },
  verifiedAt: new Date(NOW).toISOString(),
});

describe('frameleaf-license (FL-156)', () => {
  describe(verifyLicenseCertificate.name, () => {
    it('verifies a certificate signed by the active key', () => {
      const result = verifyLicenseCertificate(signCertificate(active.privateKey, active.key.kid), context);
      expect(result).toMatchObject({ ok: true, kid: active.key.kid, claims: { iid: 'instance-1', sub: 'account-1' } });
    });

    it('verifies a certificate signed by the spare key', () => {
      expect(verifyLicenseCertificate(signCertificate(spare.privateKey, spare.key.kid), context)).toMatchObject({
        ok: true,
        kid: spare.key.kid,
      });
    });

    it.each([
      ['an unknown kid', () => signCertificate(stranger.privateKey, stranger.key.kid), 'unknown-kid'],
      [
        'a signature by another key under a pinned kid',
        () => signCertificate(stranger.privateKey, active.key.kid),
        'signature',
      ],
      ['a wrong sub', () => signCertificate(active.privateKey, active.key.kid, { sub: 'account-2' }), 'account'],
      ['a wrong iid', () => signCertificate(active.privateKey, active.key.kid, { iid: 'instance-2' }), 'instance'],
      [
        'another audience',
        () => signCertificate(active.privateKey, active.key.kid, { aud: 'someone-else' }),
        'audience',
      ],
      [
        'a future nbf',
        () => signCertificate(active.privateKey, active.key.kid, { nbf: nowSeconds + 3600 }),
        'not-yet-valid',
      ],
      ['a past exp', () => signCertificate(active.privateKey, active.key.kid, { exp: nowSeconds - 1 }), 'expired'],
      ['another type', () => signCertificate(active.privateKey, active.key.kid, {}, { typ: 'JWT' }), 'type'],
      [
        'another algorithm',
        () => signCertificate(active.privateKey, active.key.kid, {}, { alg: 'RS256' }),
        'algorithm',
      ],
      [
        'a different key binding',
        () => signCertificate(active.privateKey, active.key.kid, { cnf: { jkt: 'other' } }),
        'key-binding',
      ],
    ])('refuses %s', (_name, make, reason) => {
      expect(verifyLicenseCertificate(make(), { ...context, jkt: 'mine' })).toEqual({ ok: false, reason });
    });

    it('refuses a tampered payload', () => {
      const [head, , signature] = signCertificate(active.privateKey, active.key.kid).split('.', 3);
      const tampered = b64({
        iss: 'x',
        aud: 'frameleaf-server',
        sub: 'account-1',
        iid: 'instance-1',
        ent: ['CLOUD'],
        iat: nowSeconds,
        exp: nowSeconds + 1e6,
      });
      expect(verifyLicenseCertificate(`${head}.${tampered}.${signature}`, context)).toEqual({
        ok: false,
        reason: 'signature',
      });
    });

    it('refuses garbage', () => {
      expect(verifyLicenseCertificate('not a certificate', context)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('checks the account only when this server knows it', () => {
      const certificate = signCertificate(active.privateKey, active.key.kid, { sub: 'account-9' });
      expect(verifyLicenseCertificate(certificate, { ...context, accountId: null })).toMatchObject({ ok: true });
    });

    it('never trusts the placeholder pins with a key this build does not hold', () => {
      const certificate = signCertificate(active.privateKey, active.key.kid);
      expect(verifyLicenseCertificate(certificate, { ...context, keys: FRAMELEAF_LICENSE_KEYS })).toEqual({
        ok: false,
        reason: 'unknown-kid',
      });
      expect(FRAMELEAF_LICENSE_KEYS.map(({ status }) => status)).toEqual(['active', 'spare']);
    });
  });

  describe(licenseStatus.name, () => {
    it('is none without a certificate', () => {
      expect(licenseStatus(null, NOW)).toEqual({ state: 'none', expiresAt: null, graceUntil: null });
    });

    it('is active until the period or certificate ends, then in grace for grace_days, then expired', () => {
      const license = stored({ lic_exp: nowSeconds + 86_400, grace_days: 7 });
      expect(licenseStatus(license, NOW).state).toBe('active');
      const end = (nowSeconds + 86_400) * 1000;
      expect(licenseStatus(license, end + 1000)).toEqual({
        state: 'grace',
        expiresAt: new Date(end),
        graceUntil: new Date(end + 7 * 86_400_000),
      });
      expect(licenseStatus(license, end + 7 * 86_400_000 + 1000).state).toBe('expired');
    });

    it('uses the certificate exp when it comes before the period end (refresh failing)', () => {
      const license = stored({ lic_exp: nowSeconds + 90 * 86_400, exp: nowSeconds + 86_400, grace_days: 14 });
      expect(licenseStatus(license, (nowSeconds + 2 * 86_400) * 1000).state).toBe('grace');
      expect(licenseStatus(license, (nowSeconds + 16 * 86_400) * 1000).state).toBe('expired');
    });

    it('keeps a lifetime supporter key active', () => {
      const license = stored({ ent: ['SUPPORTER_SERVER'], lic_exp: null, exp: nowSeconds - 365 * 86_400 });
      expect(licenseStatus(license, NOW)).toEqual({ state: 'active', expiresAt: null, graceUntil: null });
    });
  });

  describe(entitlementFlags.name, () => {
    it('keeps cloud flags on through grace and turns them off past it', () => {
      const plan = stored({ lic_exp: nowSeconds + 86_400 });
      expect(entitlementFlags([plan], NOW)).toEqual({
        frameleafCloud: true,
        remoteAccess: true,
        cloudMl: true,
        cloudBackup: true,
        supporter: false,
      });
      expect(entitlementFlags([plan], (nowSeconds + 3 * 86_400) * 1000).remoteAccess).toBe(true);
      expect(entitlementFlags([plan], (nowSeconds + 30 * 86_400) * 1000)).toEqual({
        frameleafCloud: false,
        remoteAccess: false,
        cloudMl: false,
        cloudBackup: false,
        supporter: false,
      });
    });

    it('combines a supporter key and a plan', () => {
      const key = stored({ ent: ['SUPPORTER_SERVER'], lic_exp: null, lic: { last4: 'J58U', kind: 'server' } });
      expect(entitlementFlags([key, null], NOW)).toMatchObject({ supporter: true, remoteAccess: false });
      expect(isLicensed({ key, plan: null }, NOW)).toBe(true);
      expect(isLicensed({ key: null, plan: null }, NOW)).toBe(false);
    });
  });

  it('tells a supporter key from a plan', () => {
    expect(certificateKind(stored({}).claims)).toBe('plan');
    expect(certificateKind(stored({ lic: { kind: 'server' } }).claims)).toBe('server');
    expect(certificateKind(stored({ lic: { kind: 'individual' } }).claims)).toBe('individual');
  });

  it('schedules the refresh upd.after seconds after issue, with at most an hour of jitter', () => {
    const claims = stored({ iat: nowSeconds, upd: { after: 86_400 } }).claims;
    expect(nextRefreshAt(claims, () => 0).getTime()).toBe((nowSeconds + 86_400) * 1000);
    expect(nextRefreshAt(claims, () => 0.9999).getTime()).toBeLessThan((nowSeconds + 86_400 + 3600) * 1000);
  });

  describe(checkLicenseKey.name, () => {
    // Fixtures ported from frameleaf-cloud (FL-182, decision #40): the Luhn mod 32 check symbol,
    // see server/test/fixtures/frameleaf-cloud-contracts/licence/check-symbol/SOURCE.md.
    const valid = cloudContractFixture<{
      keys: Array<{ key: string; kind: 'server' | 'individual'; last4: string }>;
      pair: { body: string; server: string; individual: string };
    }>('licence/check-symbol/valid.json');
    const substitutions = cloudContractFixture<{ reason: string; substitutions: Array<{ input: string }> }>(
      'licence/check-symbol/substitutions.json',
    );
    const transpositions = cloudContractFixture<{ reason: string; transpositions: Array<{ input: string }> }>(
      'licence/check-symbol/transpositions.json',
    );
    const upstream = cloudContractFixture<{ reason: string; inputs: string[] }>('licence/check-symbol/upstream.json');

    it.each(valid.keys)('accepts $key', ({ key, kind, last4 }) => {
      expect(checkLicenseKey(key)).toEqual({ valid: true, key, kind, last4 });
    });

    it('accepts fl-ic8q-bt2q-8el6 lower case (trim and upper case only)', () => {
      expect(checkLicenseKey('fl-ic8q-bt2q-8el6')).toEqual({
        valid: true,
        key: 'FL-IC8Q-BT2Q-8EL6',
        kind: 'individual',
        last4: '8EL6',
      });
    });

    it('gives the same body a different check symbol for each kind', () => {
      expect(checkLicenseKey(valid.pair.server)).toMatchObject({ valid: true, kind: 'server' });
      expect(checkLicenseKey(valid.pair.individual)).toMatchObject({ valid: true, kind: 'individual' });
    });

    it('refuses every single-symbol substitution of a valid key', () => {
      for (const { input } of substitutions.substitutions) {
        expect(checkLicenseKey(input)).toEqual({ valid: false, reason: substitutions.reason });
      }
    });

    it('refuses every adjacent transposition of a valid key', () => {
      for (const { input } of transpositions.transpositions) {
        expect(checkLicenseKey(input)).toEqual({ valid: false, reason: transpositions.reason });
      }
    });

    it('refuses upstream product keys as upstream, not as a typo', () => {
      for (const input of upstream.inputs) {
        expect(checkLicenseKey(input)).toEqual({ valid: false, reason: upstream.reason });
      }
    });

    it.each([
      ['FL-X8NL-49G8-J58U', 'kind'],
      ['FL-S8NL-49G8-J58O', 'symbols'],
      ['FL-S8NL-49G8', 'format'],
    ])('refuses %s (%s)', (key, reason) => {
      expect(checkLicenseKey(key)).toEqual({ valid: false, reason });
    });
  });

  describe('golden licence fixtures (FL-184, FC-22 final)', () => {
    // packages/contracts fixtures/licence/keys.json: the cloud's own pinned keys document. Status
    // here is descriptive only (verifyLicenseCertificate never reads it, only the kid); "next" and
    // "retired" both map to "spare" so every key in the document can be trusted by this test's context.
    const goldenKeys: LicenseSigningKey[] = cloudContractFixture<{
      keys: Array<{ kty: string; crv: string; x: string; kid: string; status: string }>;
    }>('licence/keys.json').keys.map(({ kid, x, status }) => ({
      kid,
      x,
      status: status === 'active' ? 'active' : 'spare',
    }));

    /** Wraps decoded claims as a stored `FrameleafLicense` for `licenseStatus`/`entitlementFlags`, which
     * read only `.claims`; the other fields are never inspected by either function. */
    const asStoredLicense = (claims: FrameleafLicenseClaims, kid = 'x'): FrameleafLicense => ({
      certificate: 'x',
      kind: 'plan',
      source: 'account',
      kid,
      claims,
      verifiedAt: new Date().toISOString(),
    });

    it.each([
      'empty-plan.json',
      'expired-new.json',
      'expired-past-grace.json',
      'expired-within-grace.json',
      'lifetime-after-exp.json',
      'tampered.json',
      'unknown-kid.json',
      'valid-active-key.json',
      'valid-key-certificate.json',
      'valid-next-key.json',
      'wrong-iid.json',
      'wrong-jkt.json',
      'wrong-sub.json',
    ])('matches the golden verdict in licence/certificates/%s', (name) => {
      const golden = cloudContractFixture<{
        jws: string;
        context: { instanceId: string; accountId: string; jkt: string; now: number; allowExpired: boolean };
        expect:
          { ok: false; reason: string } | { ok: true; kind: string; state: string; flags?: Record<string, boolean> };
      }>(`licence/certificates/${name}`);
      const result = verifyLicenseCertificate(golden.jws, {
        keys: goldenKeys,
        instanceId: golden.context.instanceId,
        accountId: golden.context.accountId,
        jkt: golden.context.jkt,
        now: golden.context.now * 1000,
        allowExpired: golden.context.allowExpired,
      });
      if (!golden.expect.ok) {
        expect(result).toEqual({ ok: false, reason: golden.expect.reason });
        return;
      }
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const license = asStoredLicense(result.claims);
      expect(certificateKind(result.claims)).toBe(golden.expect.kind);
      expect(licenseStatus(license, golden.context.now * 1000).state).toBe(golden.expect.state);
      if (golden.expect.flags) {
        expect(entitlementFlags([license], golden.context.now * 1000)).toEqual(golden.expect.flags);
      }
    });

    it('reads the decoded claims documents the same way as their signed certificates', () => {
      // licence/certificate-claims-key.json is the decoded payload of certificates/valid-key-certificate.json
      const keyClaims = cloudContractFixture<FrameleafLicenseClaims>('licence/certificate-claims-key.json');
      expect(certificateKind(keyClaims)).toBe('server');
      expect(entitlementFlags([asStoredLicense(keyClaims)], keyClaims.iat * 1000)).toMatchObject({
        supporter: true,
        frameleafCloud: false,
      });

      // licence/certificate-claims-plan.json is the decoded payload of certificates/valid-active-key.json
      const planClaims = cloudContractFixture<FrameleafLicenseClaims>('licence/certificate-claims-plan.json');
      expect(certificateKind(planClaims)).toBe('plan');
      expect(entitlementFlags([asStoredLicense(planClaims)], planClaims.iat * 1000)).toEqual({
        frameleafCloud: true,
        remoteAccess: true,
        cloudMl: true,
        cloudBackup: true,
        supporter: false,
      });

      // licence/certificate-claims-plan-empty.json: a plan that ended, every flag off (empty-plan.json)
      const emptyClaims = cloudContractFixture<FrameleafLicenseClaims>('licence/certificate-claims-plan-empty.json');
      expect(certificateKind(emptyClaims)).toBe('plan');
      expect(entitlementFlags([asStoredLicense(emptyClaims)], emptyClaims.iat * 1000)).toEqual({
        frameleafCloud: false,
        remoteAccess: false,
        cloudMl: false,
        cloudBackup: false,
        supporter: false,
      });
    });

    it('accepts the golden server and personal activation requests’ keys', () => {
      const server = cloudContractFixture<{ key: string; fingerprint: { instanceId: string; jkt: string } }>(
        'licence/activation-request.json',
      );
      expect(checkLicenseKey(server.key)).toMatchObject({ valid: true, kind: 'server' });
      expect(server.fingerprint.instanceId).toEqual(expect.any(String));
      expect(server.fingerprint.jkt).toEqual(expect.any(String));

      const personal = cloudContractFixture<{
        key: string;
        fingerprint: { instanceId: string; jkt: string; user: string };
      }>('licence/activation-request-personal.json');
      expect(checkLicenseKey(personal.key)).toMatchObject({ valid: true, kind: 'individual' });
      // the binding is a sha256 hex digest, never the account id or email itself (FL-171 personal keys)
      expect(personal.fingerprint.user).toMatch(/^[\da-f]{64}$/);
    });

    it('accepts the golden offline-activation-request’s key (an air-gapped install, FC-22)', () => {
      const offline = cloudContractFixture<{ key: string; request: { instanceId: string; instanceName: string } }>(
        'licence/offline-activation-request.json',
      );
      expect(checkLicenseKey(offline.key)).toMatchObject({ valid: true });
      expect(offline.request.instanceName).toEqual(expect.any(String));
    });

    type ActivationJose = {
      header: { alg: string; typ: string; kid: string; jwk?: { kty: string; crv: string; x: string } };
      payload: { fingerprint: { jkt?: string } };
      jws: string;
      expect: { accepted: boolean; cnfJkt?: string; status?: number; code?: string };
    };

    it.each(['activation-jose.json'])('accepts the golden %s activation (FL-177, as-built decision #28)', (name) => {
      const golden = cloudContractFixture<ActivationJose>(`licence/${name}`);
      expect(golden.expect.accepted).toBe(true);
      expect(activationJoseProblem(golden.header, golden.payload)).toBeNull();
      // the header's own key thumbprint is the kid the certificate would bind to (cnf.jkt)
      expect(ed25519Thumbprint(golden.header.jwk!)).toBe(golden.expect.cnfJkt);
      // the jws itself decodes to the same header and payload the fixture also states directly
      const [headerPart, payloadPart] = golden.jws.split('.', 3);
      expect(JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'))).toEqual(golden.header);
      expect(JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))).toEqual(golden.payload);
    });

    it.each([
      ['activation-jose-kid-mismatch.json', 'kid-mismatch'],
      ['activation-jose-jkt-mismatch.json', 'jkt-mismatch'],
      ['activation-jose-missing-jwk.json', 'missing-jwk'],
    ] as const)('refuses the golden %s activation the way Frameleaf Cloud does (FL-177)', (name, reason) => {
      const golden = cloudContractFixture<ActivationJose>(`licence/${name}`);
      expect(golden.expect).toMatchObject({ accepted: false, status: 401, code: 'invalid_token' });
      expect(activationJoseProblem(golden.header, golden.payload)).toBe(reason);
    });

    it('verifies every certificate the golden activation and refresh responses carry', () => {
      // licence/activation-response.json wraps the same certificate as certificates/valid-key-certificate.json
      const activation = cloudContractFixture<{ certificate: string; activationId: string }>(
        'licence/activation-response.json',
      );
      const activationClaims = cloudContractFixture<FrameleafLicenseClaims>('licence/certificate-claims-key.json');
      const activationResult = verifyLicenseCertificate(activation.certificate, {
        keys: goldenKeys,
        instanceId: activationClaims.iid,
        accountId: activationClaims.sub,
        now: activationClaims.iat * 1000 + 60_000,
      });
      expect(activationResult.ok).toBe(true);
      if (activationResult.ok) {
        expect(certificateKind(activationResult.claims)).toBe('server');
      }
      expect(activation.activationId).toEqual(expect.any(String));

      // licence/refresh-response.json carries the plan certificate again (same as valid-active-key.json)
      const refresh = cloudContractFixture<{ certificates: string[] }>('licence/refresh-response.json');
      const planClaims = cloudContractFixture<FrameleafLicenseClaims>('licence/certificate-claims-plan.json');
      for (const certificate of refresh.certificates) {
        const result = verifyLicenseCertificate(certificate, {
          keys: goldenKeys,
          instanceId: planClaims.iid,
          accountId: planClaims.sub,
          now: planClaims.iat * 1000 + 60_000,
        });
        expect(result.ok).toBe(true);
      }
    });

    it('matches the golden refresh-request’s shape: the instance id and each held certificate’s jti', () => {
      // licence/refresh-request.json: this server reports which certificates it currently holds (by
      // jti) so Frameleaf Cloud can tell it apart from one asking cold; a slot with no certificate of
      // that kind sends null, matching the shape the refresh() request body builds from
      // `[store.key, store.plan]`.
      const golden = cloudContractFixture<{ instanceId: string; certificates: Array<string | null> }>(
        'licence/refresh-request.json',
      );
      expect(golden.instanceId).toEqual(expect.any(String));
      for (const certificate of golden.certificates) {
        expect(certificate === null || typeof certificate === 'string').toBe(true);
      }
    });

    it('matches the golden deactivate-request’s shape', () => {
      const golden = cloudContractFixture<{
        activationId: string;
        licenseId: string;
        fingerprint: { instanceId: string };
      }>('licence/deactivate-request.json');
      expect(golden).toMatchObject({
        activationId: expect.any(String),
        licenseId: expect.any(String),
        fingerprint: { instanceId: expect.any(String) },
      });
    });

    it('reads the golden entitlements-response’s certificates the same way as its summary', () => {
      // licence/entitlements-response.json carries the same plan and key certificates as
      // certificates/valid-active-key.json and certificate-claims-key.json, at a time (context.now,
      // 60 s after their shared iat) both are active.
      const golden = cloudContractFixture<{
        instanceId: string;
        certificates: string[];
        summary: { state: string; entitlements: string[]; licenseKid: string };
      }>('licence/entitlements-response.json');
      const claims = cloudContractFixture<FrameleafLicenseClaims>('licence/certificate-claims-plan.json');
      const now = claims.iat * 1000 + 60_000;
      const licenses = golden.certificates.map((certificate) => {
        const result = verifyLicenseCertificate(certificate, { keys: goldenKeys, instanceId: golden.instanceId, now });
        expect(result.ok).toBe(true);
        return result.ok ? asStoredLicense(result.claims, result.kid) : null;
      });
      const kinds = licenses.map((license) => license && certificateKind(license.claims));
      expect(kinds.sort()).toEqual(['plan', 'server']);
      expect(entitlementFlags(licenses, now)).toEqual({
        frameleafCloud: true,
        remoteAccess: true,
        cloudMl: true,
        cloudBackup: true,
        supporter: true,
      });
      const activeKid = licenses.find((license) => license && certificateKind(license.claims) === 'server')?.kid;
      expect(activeKid).toBe(golden.summary.licenseKid);
      expect(golden.summary.state).toBe('active');
    });
  });
});

describe('published pricing', () => {
  const NOW_MS = Date.UTC(2026, 9, 5, 12);
  const pricing = (pricesVersion: string, licensedDiscountPercent: number, effectiveFrom: string) => ({
    pricesVersion,
    licensedDiscountPercent,
    effectiveFrom,
  });
  const published = pricing('2026-10-01.2', 25, '2026-10-01T00:00:00Z');
  const lastGood = { current: pricing('2026-09-30.1', 15, '2026-09-30T00:00:00Z') };

  it('makes a valid pricing whose time has come current, dropping anything else it carries', () => {
    expect(acceptPublishedPricing({ ...published, extra: true }, null, NOW_MS)).toEqual({ current: published });
    expect(effectivePricing({ current: published }, NOW_MS).licensedDiscountPercent).toBe(25);
    for (const percent of [0, 50]) {
      const edge = pricing('2026-10-02.1', percent, '2026-10-02T00:00:00Z');
      expect(acceptPublishedPricing(edge, lastGood, NOW_MS)).toEqual({ current: edge });
    }
  });

  it('keeps the bundled pricing when nothing is published', () => {
    expect(acceptPublishedPricing(undefined, null, NOW_MS)).toEqual({ current: null });
    expect(effectivePricing(null, NOW_MS)).toEqual(BUNDLED_PRICING);
    expect(BUNDLED_PRICING).toEqual(pricing('2026-09-25.1', 20, '2026-09-25T00:00:00Z'));
  });

  it.each([
    ['above 50', { licensedDiscountPercent: 51 }],
    ['negative', { licensedDiscountPercent: -1 }],
    ['fractional', { licensedDiscountPercent: 12.5 }],
    ['a string', { licensedDiscountPercent: '20' }],
  ])('ignores a discount that is %s', (_label, patch) => {
    expect(acceptPublishedPricing({ ...published, ...patch }, lastGood, NOW_MS)).toEqual(lastGood);
  });

  it.each([
    ['without a revision', '2026-10-01'],
    ['in another format', 'v2026.10.01'],
    ['too long', `2026-10-01.${'1'.repeat(30)}`],
    ['missing', undefined],
  ])('ignores a prices version %s', (_label, pricesVersion) => {
    expect(acceptPublishedPricing({ ...published, pricesVersion }, lastGood, NOW_MS)).toEqual(lastGood);
  });

  it.each([
    ['not a date', 'soon'],
    ['a date without a time', '2026-10-01'],
    ['with an offset instead of UTC', '2026-10-01T00:00:00+02:00'],
  ])('ignores an effective date that is %s', (_label, effectiveFrom) => {
    expect(acceptPublishedPricing({ ...published, effectiveFrom }, lastGood, NOW_MS)).toEqual(lastGood);
  });

  it('keeps the last good pricing through a bad or missing value, and uses it over the bundle', () => {
    let kept = acceptPublishedPricing(published, null, NOW_MS);
    kept = acceptPublishedPricing(null, kept, NOW_MS);
    kept = acceptPublishedPricing({ ...published, licensedDiscountPercent: 99 }, kept, NOW_MS);
    expect(kept).toEqual({ current: published });
    expect(effectivePricing(kept, NOW_MS).licensedDiscountPercent).toBe(25);
  });

  it('holds a future pricing as pending and serves it only once its time has passed', () => {
    const future = pricing('2026-11-01.1', 30, '2026-11-01T00:00:00Z');
    const kept = acceptPublishedPricing(future, lastGood, NOW_MS);
    expect(kept).toEqual({ ...lastGood, pending: future });
    expect(effectivePricing(kept, NOW_MS).licensedDiscountPercent).toBe(15);
    expect(effectivePricing(kept, Date.parse('2026-10-31T23:59:59Z')).licensedDiscountPercent).toBe(15);
    expect(effectivePricing(kept, Date.parse('2026-11-01T00:00:00Z')).licensedDiscountPercent).toBe(30);
    // the next heartbeat after that time stores it as current
    expect(acceptPublishedPricing(undefined, kept, Date.parse('2026-11-02T00:00:00Z'))).toEqual({ current: future });
    // with nothing published before, the bundle stays in force until then
    expect(effectivePricing(acceptPublishedPricing(future, null, NOW_MS), NOW_MS)).toEqual(BUNDLED_PRICING);
  });

  it('replaces a pending pricing with a newer one, and never with an older one', () => {
    const first = pricing('2026-11-01.1', 30, '2026-11-01T00:00:00Z');
    const revised = pricing('2026-11-01.2', 35, '2026-11-01T00:00:00Z');
    const later = pricing('2026-12-01.1', 40, '2026-12-01T00:00:00Z');
    let kept = acceptPublishedPricing(first, lastGood, NOW_MS);
    kept = acceptPublishedPricing(revised, kept, NOW_MS);
    expect(kept.pending).toEqual(revised);
    kept = acceptPublishedPricing(later, kept, NOW_MS);
    expect(kept.pending).toEqual(later);
    expect(acceptPublishedPricing(first, kept, NOW_MS)).toEqual(kept);
  });

  it('clears a pending pricing when the cloud publishes the one in force again, so it never applies', () => {
    const future = pricing('2026-11-01.1', 30, '2026-11-01T00:00:00Z');
    const pending = acceptPublishedPricing(future, { current: published }, NOW_MS);
    expect(pending).toEqual({ current: published, pending: future });

    const withdrawn = acceptPublishedPricing(published, pending, NOW_MS);
    expect(withdrawn).toEqual({ current: published });
    expect(effectivePricing(withdrawn, Date.parse('2026-11-02T00:00:00Z')).licensedDiscountPercent).toBe(25);
  });

  it('clears a pending pricing when a newer one comes into force, and when the bundle is republished', () => {
    const future = pricing('2026-11-01.1', 30, '2026-11-01T00:00:00Z');
    const now = pricing('2026-10-05.1', 10, '2026-10-05T00:00:00Z');
    const pending = acceptPublishedPricing(future, lastGood, NOW_MS);
    expect(acceptPublishedPricing(now, pending, NOW_MS)).toEqual({ current: now });

    const fromBundle = acceptPublishedPricing(future, null, NOW_MS);
    expect(acceptPublishedPricing(BUNDLED_PRICING, fromBundle, NOW_MS)).toEqual({ current: null });
  });

  it('ignores a pricing older than the one in force', () => {
    const current = { current: published };
    expect(acceptPublishedPricing(pricing('2026-10-01.1', 40, '2026-10-01T00:00:00Z'), current, NOW_MS)).toEqual(
      current,
    );
    expect(acceptPublishedPricing(pricing('2026-10-03.1', 40, '2026-09-30T00:00:00Z'), current, NOW_MS)).toEqual(
      current,
    );
    expect(acceptPublishedPricing({ ...published }, current, NOW_MS)).toEqual(current);
    // nor one older than the bundle when nothing was published yet
    expect(acceptPublishedPricing(pricing('2026-09-24.1', 40, '2026-09-24T00:00:00Z'), null, NOW_MS)).toEqual({
      current: null,
    });
  });

  it('orders pricings by effective time, then by version date and revision', () => {
    const at = '2026-10-01T00:00:00Z';
    expect(comparePricing(pricing('2026-10-01.10', 0, at), pricing('2026-10-01.9', 0, at))).toBe(1);
    expect(comparePricing(pricing('2026-09-30.5', 0, at), pricing('2026-10-01.1', 0, at))).toBe(-1);
    expect(comparePricing(pricing('2026-10-01.1', 0, '2026-10-02T00:00:00Z'), pricing('2026-10-09.1', 0, at))).toBe(1);
  });
});
