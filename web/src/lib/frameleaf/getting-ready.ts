/**
 * FL-295: the "Getting Ready…" screen. On the first start on a library the official server created,
 * the server serves only this page while it makes a safety copy of the database before upgrading
 * (`server/src/maintenance/first-launch-worker.service.ts`). The page polls the status the server
 * answers there; once the normal server is back (that route no longer exists, so it answers 404) it
 * moves on to sign-in or setup by itself.
 *
 * The status is read with plain `fetch`: it is not part of the API, only of that short phase.
 */

export const GETTING_READY_STATUS_URL = '/api/server/getting-ready';
export const GETTING_READY_POLL_MS = 1000;

export type GettingReadyBackup = { filename: string; takenAt: string };

export type GettingReadyStatus = {
  state: 'checking' | 'backing-up' | 'skipped' | 'done' | 'ready' | 'failed';
  copy?: 'taken' | 'skipped';
  backup?: GettingReadyBackup;
  error?: { reason: 'disk-space' | 'backup-failed'; requiredBytes?: number; availableBytes?: number };
};

export type GettingReadyPoll =
  | { kind: 'status'; status: GettingReadyStatus }
  /** The normal server answers: the copy is done and the upgrade has finished. */
  | { kind: 'finished' }
  /** No answer yet: the server is starting (or upgrading, between the two phases). */
  | { kind: 'starting' };

export const pollGettingReady = async (fetchFn: typeof fetch = fetch): Promise<GettingReadyPoll> => {
  try {
    const response = await fetchFn(GETTING_READY_STATUS_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404) {
      return { kind: 'finished' };
    }
    if (!response.ok) {
      return { kind: 'starting' };
    }
    return { kind: 'status', status: (await response.json()) as GettingReadyStatus };
  } catch {
    return { kind: 'starting' };
  }
};

/**
 * The status to show after a poll. A server that stops answering once the copy is done (or was not
 * needed) is handing over to the upgrade; an error stays on screen until the server answers again.
 */
export const advanceGettingReady = (
  previous: GettingReadyStatus | undefined,
  poll: GettingReadyPoll,
): GettingReadyStatus | undefined | 'finished' => {
  switch (poll.kind) {
    case 'finished': {
      return 'finished';
    }
    case 'status': {
      return poll.status;
    }
    case 'starting': {
      if (previous && ['done', 'skipped', 'ready'].includes(previous.state)) {
        return { ...previous, state: 'ready' };
      }
      return previous;
    }
  }
};

export type GettingReadyTaskId = 'copy' | 'upgrade';
export type GettingReadyTaskStatus = 'done' | 'running' | 'queued' | 'skipped' | 'failed';
export type GettingReadyTask = { id: GettingReadyTaskId; status: GettingReadyTaskStatus };

export type GettingReadyView =
  | { kind: 'working'; state: 'checking' | 'backing-up'; tasks: GettingReadyTask[] }
  | { kind: 'skipped'; backup?: GettingReadyBackup; tasks: GettingReadyTask[] }
  | { kind: 'saved'; backup?: GettingReadyBackup; tasks: GettingReadyTask[] }
  | { kind: 'finishing'; tasks: GettingReadyTask[] }
  | {
      kind: 'failed';
      reason: 'disk-space' | 'backup-failed';
      requiredBytes?: number;
      availableBytes?: number;
      tasks: GettingReadyTask[];
    };

const tasks = (copy: GettingReadyTaskStatus, upgrade: GettingReadyTaskStatus): GettingReadyTask[] => [
  { id: 'copy', status: copy },
  { id: 'upgrade', status: upgrade },
];

export const gettingReadyView = (status: GettingReadyStatus | undefined): GettingReadyView => {
  switch (status?.state) {
    case 'skipped': {
      return { kind: 'skipped', backup: status.backup, tasks: tasks('skipped', 'queued') };
    }
    case 'done': {
      return { kind: 'saved', backup: status.backup, tasks: tasks('done', 'queued') };
    }
    case 'ready': {
      return { kind: 'finishing', tasks: tasks(status.copy === 'taken' ? 'done' : 'skipped', 'running') };
    }
    case 'failed': {
      return {
        kind: 'failed',
        reason: status.error?.reason ?? 'backup-failed',
        ...(status.error?.requiredBytes !== undefined && {
          requiredBytes: status.error.requiredBytes,
          availableBytes: status.error.availableBytes,
        }),
        tasks: tasks('failed', 'queued'),
      };
    }
    case 'backing-up': {
      return { kind: 'working', state: 'backing-up', tasks: tasks('running', 'queued') };
    }
    default: {
      return { kind: 'working', state: 'checking', tasks: tasks('running', 'queued') };
    }
  }
};

/** The pre-upgrade copy among the database backups (`immich-db-backup-<timestamp>-pre-upgrade-…`). */
export const isPreUpgradeBackup = (filename: string) =>
  /^immich-db-backup-\d{8}T\d{6}-pre-upgrade-v.*\.sql\.gz$/.test(filename);
