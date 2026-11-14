import { describe, expect, it } from 'vitest';
import { paymentsView } from '$lib/frameleaf/photography/payments';

describe('paymentsView', () => {
  it('maps the account to the mock states', () => {
    const base = { chargesEnabled: false, requirementsDue: [] as string[] };
    expect(paymentsView({ ...base, status: 'unavailable' })).toBe('unavailable');
    expect(paymentsView({ ...base, status: 'none' })).toBe('empty');
    expect(paymentsView({ ...base, status: 'disconnected', chargesEnabled: true })).toBe('empty');
    expect(paymentsView({ ...base, status: 'pending' })).toBe('connecting');
    expect(paymentsView({ ...base, status: 'pending', requirementsDue: ['external_account'] })).toBe('attention');
    expect(paymentsView({ ...base, status: 'active', chargesEnabled: true })).toBe('connected');
  });
});
