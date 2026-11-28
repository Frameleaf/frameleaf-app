import { describe, expect, it } from 'vite-plus/test';
import { formatNumber } from '@/i18n';
import type { StudioAuthContext } from '@frameleaf/host/host-contract';
import { applyNumberLocale } from '../src/number-locale';

const auth = (numberLocale?: string): StudioAuthContext => ({
  userId: 'u',
  name: 'U',
  avatarUrl: null,
  locale: 'fr',
  numberLocale,
});

describe('number format (FL-1822)', () => {
  it('follows "Dates and numbers", not the interface language, and the device when absent', () => {
    applyNumberLocale({ auth: auth('de-DE') });
    expect(formatNumber(0.5)).toBe('0,5');
    applyNumberLocale({ auth: auth('en-US') });
    expect(formatNumber(0.5)).toBe('0.5');
    applyNumberLocale({ auth: auth() });
    expect(formatNumber(0.5)).toBe(new Intl.NumberFormat().format(0.5));
  });
});
