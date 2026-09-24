import { SetMaintenanceModeDto } from 'src/dtos/maintenance.dto.js';
import { MaintenanceAction } from 'src/enum.js';

describe('SetMaintenanceModeDto', () => {
  const parse = (reason: unknown) =>
    SetMaintenanceModeDto.schema.safeParse({ action: MaintenanceAction.Start, reason });

  it('accepts a reason', () => {
    expect(parse('Upgrading storage').data).toEqual({ action: MaintenanceAction.Start, reason: 'Upgrading storage' });
  });

  it('turns control and invisible formatting characters into spaces and trims (FL-81)', () => {
    expect(parse('  Disk\r\nswap\u{0}\u{202E} now\t ').data?.reason).toBe('Disk swap now');
  });

  it('treats a blank reason as none', () => {
    expect(parse(' \n ').data?.reason).toBeUndefined();
  });

  it('rejects a reason longer than 200 characters', () => {
    expect(parse('x'.repeat(200)).success).toBe(true);
    expect(parse('x'.repeat(201)).success).toBe(false);
  });

  it('keeps the reason optional', () => {
    expect(SetMaintenanceModeDto.schema.safeParse({ action: MaintenanceAction.End }).data).toEqual({
      action: MaintenanceAction.End,
    });
  });
});
