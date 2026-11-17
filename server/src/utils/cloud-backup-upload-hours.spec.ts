import { uploadWindow } from 'src/utils/cloud-backup-upload-hours.js';

const UTC = 'UTC';
const at = (time: string, day = 17) => new Date(`2026-11-${day}T${time}:00Z`);

describe(uploadWindow.name, () => {
  it('is always open when off, or when start and stop are the same', () => {
    expect(uploadWindow({ enabled: false, start: '01:00', stop: '07:00' }, UTC, at('12:00'))).toEqual({
      open: true,
      closesAt: null,
    });
    expect(uploadWindow({ enabled: true, start: '05:00', stop: '05:00' }, UTC, at('12:00')).open).toBe(true);
  });

  it('opens at the start and closes at the stop, the same day', () => {
    const hours = { enabled: true, start: '01:00', stop: '07:00' };
    expect(uploadWindow(hours, UTC, at('00:59'))).toEqual({ open: false, opensAt: at('01:00') });
    expect(uploadWindow(hours, UTC, at('01:00'))).toEqual({ open: true, closesAt: at('07:00') });
    expect(uploadWindow(hours, UTC, at('07:00'))).toEqual({ open: false, opensAt: at('01:00', 18) });
  });

  it('runs past midnight', () => {
    const hours = { enabled: true, start: '22:00', stop: '06:00' };
    expect(uploadWindow(hours, UTC, at('23:30'))).toEqual({ open: true, closesAt: at('06:00', 18) });
    expect(uploadWindow(hours, UTC, at('05:59'))).toEqual({ open: true, closesAt: at('06:00') });
    expect(uploadWindow(hours, UTC, at('12:00'))).toEqual({ open: false, opensAt: at('22:00') });
  });

  it('reads the hours in the server’s time zone', () => {
    // 08:30 UTC is 01:30 at UTC−7 (Etc/GMT+7)
    expect(uploadWindow({ enabled: true, start: '01:00', stop: '07:00' }, 'Etc/GMT+7', at('08:30'))).toEqual({
      open: true,
      closesAt: at('14:00'),
    });
  });
});
