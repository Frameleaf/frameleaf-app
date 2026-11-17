import { uploadWindow } from 'src/utils/cloud-backup-upload-hours.js';

const at = (time: string) => new Date(`2026-11-17T${time}:00`);

describe(uploadWindow.name, () => {
  it('is always open when off, or when start and stop are the same', () => {
    expect(uploadWindow({ enabled: false, start: '01:00', stop: '07:00' }, at('12:00'))).toEqual({
      open: true,
      closesAt: null,
    });
    expect(uploadWindow({ enabled: true, start: '05:00', stop: '05:00' }, at('12:00')).open).toBe(true);
  });

  it('opens at the start and closes at the stop, the same day', () => {
    const hours = { enabled: true, start: '01:00', stop: '07:00' };
    expect(uploadWindow(hours, at('00:59'))).toEqual({ open: false, opensAt: at('01:00') });
    expect(uploadWindow(hours, at('01:00'))).toEqual({ open: true, closesAt: at('07:00') });
    expect(uploadWindow(hours, at('07:00'))).toEqual({ open: false, opensAt: new Date('2026-11-18T01:00:00') });
  });

  it('runs past midnight', () => {
    const hours = { enabled: true, start: '22:00', stop: '06:00' };
    expect(uploadWindow(hours, at('23:30'))).toEqual({ open: true, closesAt: new Date('2026-11-18T06:00:00') });
    expect(uploadWindow(hours, at('05:59'))).toEqual({ open: true, closesAt: at('06:00') });
    expect(uploadWindow(hours, at('12:00'))).toEqual({ open: false, opensAt: at('22:00') });
  });
});
