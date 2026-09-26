/**
 * The maintenance page's task list (FL-80 MS-1, M-2/M-6): the prototype's `MaintenanceSplash`
 * (`design/frameleaf/template/src/AuthScreens.jsx:1291-1381`, tasks in `system-data.mjs:768-841`)
 * shows each step of an update with done / running / waiting / on-standby status and one overall
 * progress bar. Production reports a database restore as `{ task, progress }` on its maintenance
 * status — `backup` → `restore` → `migrations`, with `rollback` only when a step failed — and the
 * progress is the whole restore's, from 0 to 1. This maps that status onto the prototype's list.
 */
import { MaintenanceAction, type MaintenanceStatusResponseDto } from '@immich/sdk';

export type MaintenanceTaskId = 'backup' | 'restore' | 'migrations' | 'rollback';
export type MaintenanceTaskStatus = 'done' | 'running' | 'queued' | 'standby' | 'failed';

export type MaintenanceTask = { id: MaintenanceTaskId; status: MaintenanceTaskStatus };

const STEPS: MaintenanceTaskId[] = ['backup', 'restore', 'migrations'];

export type MaintenancePageState =
  /** Plain maintenance mode, or a status not yet loaded. */
  | { kind: 'maintenance' }
  | { kind: 'restoring'; tasks: MaintenanceTask[]; percent: number; current?: MaintenanceTaskId }
  | { kind: 'restore-failed'; error: string }
  | { kind: 'select-restore' }
  | { kind: 'finished' };

export const maintenanceRestoreTasks = (task: string | undefined): MaintenanceTask[] => {
  if (task === 'rollback') {
    // The restore failed and the server is putting the restore point back.
    return [
      { id: 'backup', status: 'done' },
      { id: 'restore', status: 'failed' },
      { id: 'migrations', status: 'queued' },
      { id: 'rollback', status: 'running' },
    ];
  }
  const index = STEPS.indexOf(task as MaintenanceTaskId);
  return [
    ...STEPS.map((id, step) => ({
      id,
      status: (index === -1
        ? 'queued'
        : step < index
          ? 'done'
          : step === index
            ? 'running'
            : 'queued') as MaintenanceTaskStatus,
    })),
    { id: 'rollback', status: 'standby' },
  ];
};

/** Strips the noise lines a failed `pg_restore` prints before its real error. */
export const maintenanceErrorText = (error: string) =>
  error
    .split('\n')
    .filter((line) => !line.includes('drop cascades'))
    .join('\n');

export const maintenancePageState = (
  status: MaintenanceStatusResponseDto | undefined,
  { signedIn }: { signedIn: boolean },
): MaintenancePageState => {
  switch (status?.action) {
    case MaintenanceAction.End: {
      return { kind: 'finished' };
    }
    case MaintenanceAction.RestoreDatabase: {
      if (status.error) {
        return { kind: 'restore-failed', error: maintenanceErrorText(status.error) };
      }
      const tasks = maintenanceRestoreTasks(status.task);
      const percent = Math.round(Math.min(1, Math.max(0, status.progress ?? 0)) * 100);
      return { kind: 'restoring', tasks, percent, current: tasks.find((task) => task.status === 'running')?.id };
    }
    case MaintenanceAction.SelectDatabaseRestore: {
      return signedIn ? { kind: 'select-restore' } : { kind: 'maintenance' };
    }
    default: {
      return { kind: 'maintenance' };
    }
  }
};

/**
 * FL-81 version compatibility of a backup with the running server, read from the backup's file name
 * (`immich-db-backup-<date>-v<version>-pg<pg>.sql.gz`). Migrations only move a database forward, so a
 * backup from a newer server cannot be restored here (the server refuses it as well); an older one is
 * migrated after the restore.
 */
export type BackupVersionCompatibility = 'same' | 'older' | 'newer' | 'unknown';

const parseVersion = (value: string | undefined) => {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

export const backupFileVersion = (filename: string) => filename.match(/-v(.*)-/)?.[1];

export const backupVersionCompatibility = (
  backupVersion: string | undefined,
  serverVersion: string,
): BackupVersionCompatibility => {
  const backup = parseVersion(backupVersion);
  const server = parseVersion(serverVersion);
  if (!backup || !server || serverVersion === '0.0.0') {
    return 'unknown';
  }
  for (let index = 0; index < 3; index++) {
    if (backup[index] !== server[index]) {
      return backup[index] > server[index] ? 'newer' : 'older';
    }
  }
  return 'same';
};
