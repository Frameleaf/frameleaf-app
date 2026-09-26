import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CLOUD_BACKUP_PRICING,
  cloudBackupMonthlyUsd,
  cloudPlanPrice,
  discountPercent,
  formatCountdown,
  formatUsd,
  normalizeProductKey,
  secondsUntil,
  shortFingerprint,
  storeProductUrl,
  validateProductKey,
} from '$lib/frameleaf/cloud';

// Fixtures ported from frameleaf-cloud (FL-182, decision #40): the Luhn mod 32 check symbol, see
// server/test/fixtures/frameleaf-cloud-contracts/licence/check-symbol/SOURCE.md.
const checkSymbolFixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      resolve(process.cwd(), '..', 'server/test/fixtures/frameleaf-cloud-contracts/licence/check-symbol', name),
      'utf8',
    ),
  ) as T;

describe('Frameleaf Cloud helpers', () => {
  describe('validateProductKey (FL-171)', () => {
    const valid = checkSymbolFixture<{
      keys: Array<{ key: string; kind: 'server' | 'individual'; last4: string }>;
      pair: { body: string; server: string; individual: string };
    }>('valid.json');
    const substitutions = checkSymbolFixture<{ reason: string; substitutions: Array<{ input: string }> }>(
      'substitutions.json',
    );
    const transpositions = checkSymbolFixture<{ reason: string; transpositions: Array<{ input: string }> }>(
      'transpositions.json',
    );
    const upstream = checkSymbolFixture<{ reason: string; inputs: string[] }>('upstream.json');
    const normalise = checkSymbolFixture<{ cases: Array<{ input: string; key: string }> }>('normalise.json');

    it.each(valid.keys)('accepts $key', ({ key, kind, last4 }) => {
      expect(validateProductKey(key)).toEqual({ valid: true, key, kind, last4 });
    });

    it('gives the same body a different check symbol for each kind', () => {
      expect(validateProductKey(valid.pair.server)).toMatchObject({ valid: true, kind: 'server' });
      expect(validateProductKey(valid.pair.individual)).toMatchObject({ valid: true, kind: 'individual' });
    });

    it('normalises lower case, missing hyphens and stray spaces before checking', () => {
      for (const { input, key } of normalise.cases) {
        expect(validateProductKey(input)).toMatchObject({ valid: true, key });
      }
    });

    it('refuses every single-symbol substitution of a valid key', () => {
      for (const { input } of substitutions.substitutions) {
        expect(validateProductKey(input)).toMatchObject({ valid: false, reason: substitutions.reason });
      }
    });

    it('refuses every adjacent transposition of a valid key', () => {
      for (const { input } of transpositions.transpositions) {
        expect(validateProductKey(input)).toMatchObject({ valid: false, reason: transpositions.reason });
      }
    });

    it('refuses upstream product keys as upstream, not as a typo', () => {
      for (const input of upstream.inputs) {
        expect(validateProductKey(input)).toMatchObject({ valid: false, reason: upstream.reason });
      }
    });

    it.each([
      ['', 'empty'],
      ['FL-S8NL-49G8', 'format'],
      ['FL-X8NL-49G8-J58U', 'kind'],
      ['FL-S8NL-49G8-J58O', 'symbols'],
      ['FL-S8NL-49G8-J581', 'symbols'],
      ['IMCL-0KEY-AAAA-BBBB-CCCC', 'upstream'],
      ['IMSV-0KEY-AAAA-BBBB-CCCC', 'upstream'],
    ])('refuses %j (%s)', (input, reason) => {
      expect(validateProductKey(input)).toMatchObject({ valid: false, reason });
    });

    it('re-hyphenates as the person types', () => {
      expect(normalizeProductKey('fls8nl49')).toBe('FL-S8NL-49');
      expect(normalizeProductKey('FL-S8NL-49G8-J58U-EXTRA')).toBe('FL-S8NL-49G8-J58U');
    });
  });

  describe('prices', () => {
    it('always formats US dollars', () => {
      expect(formatUsd(6)).toBe('$6');
      expect(formatUsd(4.8)).toBe('$4.80');
      expect(formatUsd(60, 2)).toBe('$60.00');
    });

    it('takes the published share off plans, and nothing without one', () => {
      expect(cloudPlanPrice(9.99, 0)).toBe(9.99);
      expect(cloudPlanPrice(9.99, 0.2)).toBe(7.99);
      expect(cloudPlanPrice(99.9, 0.2)).toBe(79.92);
      expect(cloudPlanPrice(9.99, 0.25)).toBe(7.49);
      expect(cloudPlanPrice(99.9, 0.25)).toBe(74.93);
      expect(discountPercent(0.2)).toBe('20%');
      expect(discountPercent(0.25)).toBe('25%');
    });

    it('includes 1 TB of cloud backup with a plan and sells more in 1 TB blocks', () => {
      expect(CLOUD_BACKUP_PRICING).toEqual({ includedTb: 1, blockTb: 1, usdPerTbMonth: 9.99 });
      expect(cloudBackupMonthlyUsd(0)).toBe(0);
      expect(cloudBackupMonthlyUsd(1)).toBe(0);
      expect(cloudBackupMonthlyUsd(1.4)).toBe(9.99);
      expect(cloudBackupMonthlyUsd(2.5)).toBe(19.98);
    });

    it('does not charge another block for floating-point noise', () => {
      expect(cloudBackupMonthlyUsd(2)).toBe(9.99);
      expect(cloudBackupMonthlyUsd(2 + 2 * Number.EPSILON)).toBe(9.99);
      expect(cloudBackupMonthlyUsd(1 + Number.EPSILON)).toBe(0);
      expect(cloudBackupMonthlyUsd(2.001)).toBe(19.98);
    });
  });

  describe('device link', () => {
    it('counts down to the expiry and never goes negative', () => {
      const now = Date.UTC(2026, 8, 25, 12);
      expect(secondsUntil(new Date(now + 599_500).toISOString(), now)).toBe(600);
      expect(secondsUntil(new Date(now - 1000).toISOString(), now)).toBe(0);
      expect(secondsUntil(null, now)).toBe(0);
      expect(formatCountdown(600)).toBe('10:00');
      expect(formatCountdown(65)).toBe('1:05');
    });

    it('shortens the key fingerprint', () => {
      expect(shortFingerprint('q7LkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9vXe')).toBe('SHA256:q7Lk…9vXe');
      expect(shortFingerprint(null)).toBe('');
    });
  });

  describe('storeProductUrl (FL-172)', () => {
    it('links to the product on the configured store', () => {
      expect(storeProductUrl('https://frameleaf.cloud.test/store', 'server')).toBe(
        'https://frameleaf.cloud.test/store?product=server',
      );
    });

    it('has no link without a configured store, or for a bad address', () => {
      expect(storeProductUrl(null, 'server')).toBeNull();
      expect(storeProductUrl('javascript:alert(1)', 'server')).toBeNull();
      expect(storeProductUrl('not a url', 'server')).toBeNull();
    });
  });
});

describe('licensedDiscount (FL-156)', () => {
  it('counts an activated server key or the viewer’s own supporter key, server first', async () => {
    const { licensedDiscount } = await import('$lib/frameleaf/cloud');
    expect(licensedDiscount({ serverLicensed: true, personalKey: true })).toBe('server');
    expect(licensedDiscount({ serverLicensed: false, personalKey: true })).toBe('personal');
    expect(licensedDiscount({ serverLicensed: false, personalKey: false })).toBeNull();
  });
});

describe('linkRefusalKeys (FL-177)', () => {
  it('gives every refused link its own title and help', async () => {
    const { linkRefusalKeys } = await import('$lib/frameleaf/cloud');
    const { CloudLinkRefusal } = await import('@immich/sdk');
    const keys = Object.values(CloudLinkRefusal).map((refusal) => linkRefusalKeys(refusal));
    expect(new Set(keys.map(({ title }) => title)).size).toBe(Object.values(CloudLinkRefusal).length);
    for (const { title, body } of keys) {
      expect(title).toMatch(/^frameleaf_cloud_link_refusal_.+_title$/);
      expect(body).toBe(title.replace(/_title$/, '_body'));
    }
  });
});
