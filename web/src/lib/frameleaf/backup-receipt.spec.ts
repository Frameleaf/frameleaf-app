import type { BackupDeviceDto } from '@frameleaf/sdk';
import { reasonKey, receiptReasons, receiptState, serverVerified, waitingTotal } from '$lib/frameleaf/backup-receipt';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const phone = (overrides: Partial<BackupDeviceDto> = {}) =>
  ({
    id: 'p1',
    displayName: 'Taylor’s iPhone',
    phoneItemCount: 12_348,
    pendingReasons: [],
    lastCheck: {
      id: 'r1',
      checkedAt: '2026-11-10T03:10:00Z',
      completedAt: '2026-11-10T03:14:00Z',
      itemsChecked: 12_340,
      itemsMissing: 0,
    },
    ...overrides,
  }) as BackupDeviceDto;

describe('backup receipt (FL-792)', () => {
  it('reads each spelling of a known reason and leaves the rest as unknown', () => {
    expect(reasonKey('wifi')).toBe('wifi');
    expect(reasonKey('low-power')).toBe('low_power');
    expect(reasonKey('lowPower')).toBe('low_power');
    expect(reasonKey('icloudOriginals')).toBe('icloud_original');
    expect(reasonKey('too_large')).toBe('too_large');
    expect(reasonKey('quantum-flux')).toBe('unknown');
    expect(reasonKey('')).toBe('unknown');
    expect(reasonKey('constructor')).toBe('unknown');
    expect(reasonKey('toString')).toBe('unknown');
    expect(reasonKey('__proto__')).toBe('unknown');
  });

  it('adds codes that mean the same reason and adds the check’s missing items', () => {
    const reasons = receiptReasons(
      phone({
        pendingReasons: [
          { code: 'wifi', count: 4 },
          { code: 'WiFi', count: 2 },
          { code: 'brand-new-code', count: 1 },
          { code: 'charging', count: 0 },
        ],
        lastCheck: { ...phone().lastCheck!, itemsMissing: 3 },
      }),
    );
    expect(reasons).toEqual([
      { key: 'wifi', count: 6 },
      { key: 'unknown', count: 1 },
      { key: 'not_on_server', count: 3 },
    ]);
  });

  it('counts only what the server proved', () => {
    expect(serverVerified(phone())).toBe(12_340);
    expect(serverVerified(phone({ lastCheck: { ...phone().lastCheck!, itemsMissing: 11 } }))).toBe(12_329);
    expect(serverVerified(phone({ lastCheck: null }))).toBeNull();
    expect(waitingTotal(phone({ pendingReasons: [{ code: 'wifi', count: 8 }] }))).toBe(8);
  });

  it('tells never checked from a check this session may not see', () => {
    expect(receiptState(phone({ lastCheck: null }), true, NOW)).toBe('never');
    expect(receiptState(phone({ lastCheck: null }), false, NOW)).toBe('locked');
    expect(receiptState(phone(), true, NOW)).toBe('safe');
    expect(receiptState(phone({ lastCheck: { ...phone().lastCheck!, itemsMissing: 1 } }), true, NOW)).toBe('missing');
    expect(
      receiptState(phone({ lastCheck: { ...phone().lastCheck!, completedAt: '2026-11-01T03:14:00Z' } }), true, NOW),
    ).toBe('stale');
  });
});
