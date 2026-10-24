import type { IdenticalFilesStatusDto } from '@frameleaf/sdk';

/**
 * FL-416: "Checking your Immich library" (the approved prototype `settings-v2/care/import-check.jsx`).
 * After an Immich import the identical-files check reads every imported file once; Library care shows
 * where it stands while it runs and for a week after it finished.
 */
export const IMPORT_CHECK_SHOWN_FOR_MS = 7 * 24 * 60 * 60 * 1000;

export type ImportCheckStep = 'read' | 'recover' | 'move';
export type ImportCheckStepStatus = 'done' | 'running' | 'queued';
export type ImportCheckView = {
  finished: boolean;
  /** 0 to 100, for the bar. */
  percent: number;
  steps: Array<{ id: ImportCheckStep; status: ImportCheckStepStatus; percent?: number }>;
  checked: number;
  total: number;
  merged: number;
  recovered: number;
  movedBytes: number;
  /** Minutes left while every file is still being read, from how fast it has gone so far. */
  minutesLeft?: number;
};

/** Whether Library care shows the card: the latest check came from an Immich import and is recent. */
export const showsImportCheck = (status: IdenticalFilesStatusDto | undefined, now = Date.now()) => {
  if (!status || status.trigger !== 'immich-import') {
    return false;
  }
  if (status.status === 'running') {
    return true;
  }
  const finished = status.finishedAt ? new Date(status.finishedAt).getTime() : NaN;
  return Number.isFinite(finished) && now - finished < IMPORT_CHECK_SHOWN_FOR_MS;
};

/** Where the check stands, in the card's three steps. Reading every file is most of the work. */
export const importCheckView = (status: IdenticalFilesStatusDto, now = Date.now()): ImportCheckView => {
  const finished = status.status === 'completed';
  const stage = status.stage ?? 'scan';
  const total = status.totalOriginals;
  const checked = finished ? Math.max(total, status.counts.scanned) : Math.min(total, status.counts.scanned);
  const reading = !finished && ['scan', 'link', 'merge'].includes(stage);
  const readPart = total > 0 ? checked / total : stage === 'scan' ? 0 : 1;
  const percent = finished
    ? 100
    : stage === 'scan'
      ? Math.floor(readPart * 85)
      : stage === 'link'
        ? 87
        : stage === 'merge'
          ? 90
          : 95;

  let minutesLeft: number | undefined;
  const started = status.startedAt ? new Date(status.startedAt).getTime() : NaN;
  if (stage === 'scan' && !finished && checked > 0 && total > checked && Number.isFinite(started)) {
    const perFile = (now - started) / checked;
    minutesLeft = Math.max(1, Math.ceil((perFile * (total - checked)) / 60_000));
  }

  return {
    finished,
    percent,
    steps: [
      {
        id: 'read',
        status: reading ? 'running' : 'done',
        ...(reading && { percent: stage === 'scan' ? Math.floor(readPart * 100) : 99 }),
      },
      { id: 'recover', status: finished ? 'done' : stage === 'orphans' ? 'running' : reading ? 'queued' : 'done' },
      { id: 'move', status: finished ? 'done' : 'queued' },
    ],
    checked,
    total,
    merged: status.counts.photosMerged + status.counts.linked,
    recovered: status.counts.photosRecovered,
    movedBytes: status.counts.bytesMovedToUnused,
    ...(minutesLeft !== undefined && { minutesLeft }),
  };
};
