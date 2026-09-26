import { describe, expect, it } from 'vitest';
import type { FrameleafLicense, FrameleafLicenseClaims } from 'src/types.js';
import { FRAMELEAF_LICENSE_KEYS } from 'src/constants.js';
import {
  BUNDLED_PRICING,
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
import { makeLicenseSigner, signLicenseCertificate } from 'test/fixtures/frameleaf-license.fixture.js';

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
    it.each([
      ['FL-S8NL-49G8-J58U', 'server', 'J58U'],
      ['fl-ic8q-bt2q-8elh', 'individual', '8ELH'],
    ])('accepts %s', (key, kind, last4) => {
      expect(checkLicenseKey(key)).toEqual({ valid: true, key: key.toUpperCase(), kind, last4 });
    });

    it.each([
      ['FL-S8NL-49G8-J58V', 'check'],
      ['FL-X8NL-49G8-J58U', 'kind'],
      ['FL-S8NL-49G8-J58O', 'symbols'],
      ['FL-S8NL-49G8', 'format'],
      ['IMSV-AAAA-BBBB-CCCC-DDDD', 'upstream'],
      ['IMCL-AAAA-BBBB-CCCC-DDDD', 'upstream'],
    ])('refuses %s (%s)', (key, reason) => {
      expect(checkLicenseKey(key)).toEqual({ valid: false, reason });
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
