/**
 * FL-900: the restore drill (FL-879) as Backup › Restore shows it, after the prototype's
 * `restore-drill.mjs` (prototype PR 41). Which state the card is in, which step a running drill is on,
 * and the drill's words.
 */
import type { CloudBackupDrillDto, CloudBackupStatusResponseDto } from '@frameleaf/sdk';

export type DrillCardState = 'never' | 'running' | 'passed' | 'failed';
export const DRILL_STEPS = ['fetch', 'unlock', 'rebuild', 'compare'] as const;
export type DrillStepId = (typeof DRILL_STEPS)[number];

export const drillCardState = (status: CloudBackupStatusResponseDto | null): DrillCardState => {
  if (status?.activeRun?.drill) return 'running';
  const last = status?.lastDrill;
  if (!last) return 'never';
  return last.result === 'failed' ? 'failed' : 'passed';
};

/** The step a running drill is on, from its progress (the server reports 10, 25 and 50 between steps). */
export const runningStep = (progress: number): number =>
  progress < 10 ? 0 : progress < 25 ? 1 : progress < 50 ? 2 : 3;

/** Each step's state in a finished drill: passed, the one that failed, then not reached. */
export const stepStates = (drill: Pick<CloudBackupDrillDto, 'result' | 'failedStep'>) => {
  const failedAt = drill.failedStep ? DRILL_STEPS.indexOf(drill.failedStep) : -1;
  return DRILL_STEPS.map((step, index) => ({
    step,
    state: failedAt === -1 || index < failedAt ? 'done' : index === failedAt ? 'failed' : 'skipped',
  })) as { step: DrillStepId; state: 'done' | 'failed' | 'skipped' }[];
};

/** "7F3A 9C21 …": the signing key's fingerprint in groups of four, as the report shows it. */
export const groupedFingerprint = (fingerprint: string) => fingerprint.match(/.{1,4}/g)?.join(' ') ?? fingerprint;

/** The duration in whole minutes and seconds. */
export const durationParts = (seconds: number) => ({ minutes: Math.floor(seconds / 60), seconds: seconds % 60 });

/** The report's file name: frameleaf-restore-drill-2026-11-08.json. */
export const reportFileName = (startedAt: string) => `frameleaf-restore-drill-${startedAt.slice(0, 10)}.json`;
