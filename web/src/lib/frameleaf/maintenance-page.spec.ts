import { MaintenanceAction } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  backupFileVersion,
  backupVersionCompatibility,
  maintenanceErrorText,
  maintenancePageState,
  maintenanceRestoreTasks,
} from './maintenance-page';

describe('maintenance page state (FL-80 MS-1)', () => {
  it('shows plain maintenance until a status says otherwise', () => {
    expect(maintenancePageState(undefined, { signedIn: false })).toEqual({ kind: 'maintenance' });
    expect(maintenancePageState({ active: true, action: MaintenanceAction.Start }, { signedIn: true })).toEqual({
      kind: 'maintenance',
    });
  });

  it('only offers the restore flow to a signed-in administrator', () => {
    const status = { active: true, action: MaintenanceAction.SelectDatabaseRestore };
    expect(maintenancePageState(status, { signedIn: true })).toEqual({ kind: 'select-restore' });
    expect(maintenancePageState(status, { signedIn: false })).toEqual({ kind: 'maintenance' });
  });

  it('maps a running restore onto the prototype task list with overall progress', () => {
    const state = maintenancePageState(
      { active: true, action: MaintenanceAction.RestoreDatabase, task: 'restore', progress: 0.42 },
      { signedIn: false },
    );
    expect(state).toEqual({
      kind: 'restoring',
      percent: 42,
      current: 'restore',
      tasks: [
        { id: 'backup', status: 'done' },
        { id: 'restore', status: 'running' },
        { id: 'migrations', status: 'queued' },
        { id: 'rollback', status: 'standby' },
      ],
    });
  });

  it('marks the failed step while the server rolls back', () => {
    expect(maintenanceRestoreTasks('rollback')).toEqual([
      { id: 'backup', status: 'done' },
      { id: 'restore', status: 'failed' },
      { id: 'migrations', status: 'queued' },
      { id: 'rollback', status: 'running' },
    ]);
    expect(maintenanceRestoreTasks('ready').every(({ status }) => status !== 'running')).toBe(true);
  });

  it('reports a failed restore and a finished maintenance', () => {
    expect(
      maintenancePageState(
        { active: true, action: MaintenanceAction.RestoreDatabase, error: 'NOTICE: drop cascades to x\nIM CORRUPTED' },
        { signedIn: false },
      ),
    ).toEqual({ kind: 'restore-failed', error: 'IM CORRUPTED' });
    expect(maintenancePageState({ active: false, action: MaintenanceAction.End }, { signedIn: false })).toEqual({
      kind: 'finished',
    });
    expect(maintenanceErrorText('a\nb')).toBe('a\nb');
  });
});

describe('backup version compatibility (FL-81)', () => {
  it('reads the version from a routine backup name', () => {
    expect(backupFileVersion('immich-db-backup-20260101T000000-v2.5.0-pg14.19.sql.gz')).toBe('2.5.0');
    expect(backupFileVersion('uploaded.sql')).toBeUndefined();
  });

  it('compares the backup with the running server', () => {
    expect(backupVersionCompatibility('3.2.0', '3.2.0')).toBe('same');
    expect(backupVersionCompatibility('3.1.9', '3.2.0')).toBe('older');
    expect(backupVersionCompatibility('2.10.0', '3.2.0')).toBe('older');
    expect(backupVersionCompatibility('3.10.0', '3.2.0')).toBe('newer');
    expect(backupVersionCompatibility('4.0.0', '3.2.0')).toBe('newer');
  });

  it('is unknown without a readable version on either side', () => {
    expect(backupVersionCompatibility(undefined, '3.2.0')).toBe('unknown');
    expect(backupVersionCompatibility('3.2.0', '0.0.0')).toBe('unknown');
    expect(backupVersionCompatibility('nightly', '3.2.0')).toBe('unknown');
  });
});
