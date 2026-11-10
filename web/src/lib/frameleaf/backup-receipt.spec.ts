import type { BackupDeviceDto } from '@frameleaf/sdk';
import {
  allDevices,
  pendingUploads,
  reasonKey,
  receiptReasons,
  receiptState,
  serverVerified,
  waitingTotal,
} from '$lib/frameleaf/backup-receipt';

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

  it('never says safe while items still wait to go up; photos deleted in Frameleaf do not count', () => {
    expect(receiptState(phone({ pendingReasons: [{ code: 'wifi', count: 6 }] }), true, NOW)).toBe('waiting');
    expect(receiptState(phone({ pendingReasons: [{ code: 'skipped_deleted', count: 4 }] }), true, NOW)).toBe('safe');
    expect(
      pendingUploads(
        phone({
          pendingReasons: [
            { code: 'wifi', count: 6 },
            { code: 'skipped_deleted', count: 4 },
          ],
        }),
      ),
    ).toBe(6);
  });

  it('is locked for a session that may not see checks, even when the row carries one', () => {
    const checked = phone({ lastCheck: { ...phone().lastCheck!, itemsMissing: 3 } });
    expect(receiptState(checked, false, NOW)).toBe('locked');
    expect(receiptReasons(checked, false)).toEqual([]);
    expect(waitingTotal(checked, false)).toBe(0);
  });

  it('turns stale as soon as the check is over seven days old, not a day later', () => {
    const at = (iso: string) => phone({ lastCheck: { ...phone().lastCheck!, completedAt: iso } });
    expect(receiptState(at('2026-11-03T11:00:00Z'), true, NOW)).toBe('stale');
    expect(receiptState(at('2026-11-03T13:00:00Z'), true, NOW)).toBe('safe');
  });

  it('reads every page of a device list', async () => {
    const page = vi
      .fn()
      .mockResolvedValueOnce({ devices: [phone({ id: 'a' })], nextOffset: 200 })
      .mockResolvedValueOnce({ devices: [phone({ id: 'b' })], nextOffset: null });
    expect((await allDevices(page)).map(({ id }) => id)).toEqual(['a', 'b']);
    expect(page).toHaveBeenLastCalledWith({ limit: 200, offset: 200 });
  });
});
