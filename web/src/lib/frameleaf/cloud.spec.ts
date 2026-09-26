import { describe, expect, it } from 'vitest';
import {
  CLOUD_BACKUP_PRICING,
  cloudBackupMonthlyUsd,
  cloudPlanPrice,
  formatCountdown,
  formatUsd,
  normalizeProductKey,
  secondsUntil,
  shortFingerprint,
  storeProductUrl,
  validateProductKey,
} from '$lib/frameleaf/cloud';

describe('Frameleaf Cloud helpers', () => {
  describe('validateProductKey (FL-171)', () => {
    // Vectors minted with the cloud's reference `license-key.mjs` (frameleaf-cloud design prototype).
    it.each([
      ['FL-S8NL-49G8-J58U', 'server', 'J58U'],
      ['FL-SWFD-8798-BKMA', 'server', 'BKMA'],
      ['FL-IC8Q-BT2Q-8ELH', 'individual', '8ELH'],
      ['fl i54y fdex cmsf', 'individual', 'CMSF'],
    ])('accepts %s', (input, kind, last4) => {
      expect(validateProductKey(input)).toEqual({ valid: true, key: normalizeProductKey(input), kind, last4 });
    });

    it.each([
      ['', 'empty'],
      ['FL-S8NL-49G8', 'format'],
      ['FL-X8NL-49G8-J58U', 'kind'],
      ['FL-S8NL-49G8-J58O', 'symbols'],
      ['FL-S8NL-49G8-J581', 'symbols'],
      ['FL-S8NL-49G8-J58V', 'check'],
      ['FL-S8NM-49G8-J58U', 'check'],
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

    it('takes 20 % off plans on a licensed server only', () => {
      expect(cloudPlanPrice(9.99, false)).toBe(9.99);
      expect(cloudPlanPrice(9.99, true)).toBe(7.99);
      expect(cloudPlanPrice(99.9, true)).toBe(79.92);
    });

    it('includes 1 TB of cloud backup with a plan and sells more in 1 TB blocks', () => {
      expect(CLOUD_BACKUP_PRICING).toEqual({ includedTb: 1, blockTb: 1, usdPerTbMonth: 9.99 });
      expect(cloudBackupMonthlyUsd(0)).toBe(0);
      expect(cloudBackupMonthlyUsd(1)).toBe(0);
      expect(cloudBackupMonthlyUsd(1.4)).toBe(9.99);
      expect(cloudBackupMonthlyUsd(2.5)).toBe(19.98);
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
