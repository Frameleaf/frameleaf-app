import { randomUUID } from 'node:crypto';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type {
  CloudBackupCoverageReport,
  CloudBackupSelectionRepository,
} from 'src/repositories/cloud-backup-selection.repository.js';
import type {
  FrameleafCloudBackupRepository,
  ManagedBackupApi,
} from 'src/repositories/frameleaf-cloud-backup.repository.js';
import type { BackupRunReport } from 'src/utils/frameleaf-cloud-backup.js';
import {
  type BackupCoverageRow,
  type BackupCoverageSnapshot,
  backupCoverageBodies,
  backupCoverageRevisionInputSchema,
  backupCoverageSnapshotSchema,
} from 'src/utils/frameleaf-cloud-backup-coverage.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';

/** Frameleaf Cloud keeps run telemetry, and accepts coverage for a run, for 90 days; this leaves a margin. */
const COVERAGE_WINDOW_MS = 89 * 24 * 60 * 60_000;
/** The first wait after a failed try; it doubles each time, up to the cap. */
const RETRY_BASE_MS = 5 * 60_000;
const RETRY_CAP_MS = 6 * 60 * 60_000;
/** Reports a sweep tries at most. */
const SWEEP_LIMIT = 20;

/** How a run's telemetry fared when it was reported, which decides what its coverage may claim. */
export type RunReportOutcome = 'reported' | 'reported-without-key' | 'not-reported';

/** What the status line says about the newest run's coverage. */
export type CloudBackupCoverageState = {
  state: 'published' | 'pending' | 'not-reported' | 'local';
  runId: string;
  inventoryAt: string;
  attempts: number;
};

const errorText = (error: unknown) =>
  error instanceof FrameleafCloudError
    ? `${error.status ?? 'network'} ${error.envelope?.code ?? ''}`.trim()
    : error instanceof Error
      ? error.message
      : String(error);

const statusOf = (error: unknown) => (error instanceof FrameleafCloudError ? error.status : null);

/** Thrown inside one publication attempt to say how it ended. */
class Settled extends Error {
  constructor(
    readonly status: 'published' | 'rejected' | 'retry' | 'rebuild',
    reason: string,
  ) {
    super(reason);
  }
}

/**
 * FL-362: a run's numeric coverage, published to Frameleaf Cloud's FC-149 routes once its manifest is
 * committed (or with null inclusion once it has failed without one). The report is written locally first,
 * with the exact page bodies, so every retry sends the same bytes; a lost answer is recovered by reading the
 * published state back. Publishing never blocks or fails a backup: a failure waits and is tried again after
 * the next run or by the hourly check. A report is only ever sent by the instance that wrote it.
 */
export class CloudBackupCoverage {
  constructor(
    private selection: CloudBackupSelectionRepository,
    private cloud: FrameleafCloudBackupRepository,
    private logger: LoggingRepository,
    private api: () => Promise<ManagedBackupApi>,
    /** The linked instance this server is now, or null when it is not linked. */
    private linkedInstance: () => Promise<string | null>,
  ) {}

  /**
   * Write a run's report from its inventory: once, whatever is asked later. `snapshot` is the committed
   * manifest Frameleaf Cloud can check inclusion against, or null (nothing committed, or no reference it can
   * bind), which publishes unknown inclusion. `managed` false keeps the report local (your own bucket, no
   * Frameleaf Cloud). `instanceId` is the instance this server is linked as, or null while it is not linked:
   * the first publication then binds the report to the instance it is sent as.
   */
  async write(input: {
    runId: string;
    managed: boolean;
    instanceId: string | null;
    snapshot: BackupCoverageSnapshot;
    runReport: BackupRunReport | null;
  }): Promise<CloudBackupCoverageReport | null> {
    const existing = await this.selection.getCoverageReport(input.runId);
    if (existing) {
      return existing;
    }
    const run = await this.selection.getDecisionRun(input.runId);
    if (!run) {
      // a run from before FL-362, or one that stopped before its inventory: nothing to say
      return null;
    }
    const accounts = await this.selection.getDecisionAccounts(input.runId);
    const snapshot = backupCoverageSnapshotSchema.parse(input.snapshot);
    const rows: BackupCoverageRow[] = accounts.map((account) => ({
      userFingerprint: account.userFingerprint,
      totalOriginals: account.totalOriginals,
      selectedOriginals: account.selectedOriginals,
      licenceEligible: account.licenceEligible,
      includedOriginals: snapshot === null ? null : account.licenceEligible ? account.includedOriginals : 0,
    }));
    const bodies = backupCoverageBodies({
      sequence: 1,
      inventoryAt: run.inventoryAt.toISOString(),
      snapshot,
      rows,
    });
    return this.selection.createCoverageReport({
      runId: input.runId,
      instanceId: input.instanceId,
      revisionId: bodies.header.revisionId,
      sequence: bodies.header.sequence,
      inventoryAt: run.inventoryAt,
      accountCount: bodies.header.accountCount,
      pageCount: bodies.header.pageCount,
      snapshot: snapshot as Record<string, unknown> | null,
      pages: bodies.pages,
      runReport: input.runReport as Record<string, unknown> | null,
      status: input.managed ? 'pending' : 'local',
    });
  }

  /** Publish one run's report now. Never throws: an outcome is recorded on the report. */
  async publish(runId: string, now = new Date()): Promise<void> {
    const report = await this.selection.getCoverageReport(runId);
    if (report?.status !== 'pending') {
      return;
    }
    try {
      await this.attempt(report, now);
    } catch (error) {
      if (error instanceof Settled) {
        await this.settle(report, error, now);
        return;
      }
      await this.settle(report, new Settled('retry', errorText(error)), now);
    }
  }

  /** Every report whose next try is due (after a run, and hourly). Never throws. */
  async publishDue(now = new Date()): Promise<void> {
    let due: CloudBackupCoverageReport[];
    try {
      due = await this.selection.listDueCoverageReports(now, SWEEP_LIMIT);
    } catch (error) {
      this.logger.warn(`Could not read the cloud backup coverage still to report: ${errorText(error)}`);
      return;
    }
    for (const report of due) {
      await this.publish(report.runId, now);
    }
  }

  /** What the status line says about the newest run's coverage. */
  async state(): Promise<CloudBackupCoverageState | null> {
    const report = await this.selection.getLatestCoverageReport();
    if (!report) {
      return null;
    }
    return {
      state:
        report.status === 'published'
          ? 'published'
          : report.status === 'pending'
            ? 'pending'
            : report.status === 'local'
              ? 'local'
              : 'not-reported',
      runId: report.runId,
      inventoryAt: new Date(report.inventoryAt as unknown as string).toISOString(),
      attempts: report.attempts,
    };
  }

  private async attempt(report: CloudBackupCoverageReport, now: Date) {
    const inventoryAt = new Date(report.inventoryAt as unknown as string);
    if (now.getTime() - inventoryAt.getTime() > COVERAGE_WINDOW_MS) {
      throw new Settled('rejected', 'expired');
    }
    const instance = await this.linkedInstance();
    if (!instance) {
      throw new Settled('retry', 'not linked');
    }
    if (report.instanceId === null) {
      // written while this server was not linked: it is this instance's own run
      await this.selection.updateCoverageReport(report.runId, { instanceId: instance });
    } else if (instance !== report.instanceId) {
      // a database restored onto another server: its reports belong to the server that wrote them
      throw new Settled('rejected', 'another instance');
    }
    const target = await this.api();
    let current = report;

    // A lost answer: the revision may already be published.
    if (current.revisionAccepted) {
      const state = await this.cloud.getCoverageState(target, current.runId).catch(() => null);
      if (state?.published?.revisionId === current.revisionId) {
        throw new Settled('published', 'published');
      }
    }

    for (let round = 0; round < 2; round++) {
      const header = backupCoverageRevisionInputSchema.parse({
        revisionId: current.revisionId,
        sequence: current.sequence,
        inventoryAt: new Date(current.inventoryAt as unknown as string).toISOString(),
        accountCount: current.accountCount,
        pageCount: current.pageCount,
        snapshot: current.snapshot,
      });
      try {
        await this.begin(target, current, header);
        if (!current.revisionAccepted) {
          await this.selection.updateCoverageReport(current.runId, { revisionAccepted: true });
          current = { ...current, revisionAccepted: true };
        }
        for (const [pageIndex, body] of current.pages.entries()) {
          await this.cloud.putCoveragePage(target, current.runId, current.revisionId, pageIndex, body);
        }
        await this.cloud.finalizeCoverage(target, current.runId, current.revisionId);
        throw new Settled('published', 'published');
      } catch (error) {
        if (error instanceof Settled) {
          throw error;
        }
        const status = statusOf(error);
        if (status === 404 && current.revisionAccepted && round === 0) {
          // the unpublished revision expired on Frameleaf Cloud: the same pages under a new, later revision
          current = { ...current, revisionId: randomUUID(), sequence: current.sequence + 1, revisionAccepted: false };
          await this.selection.updateCoverageReport(current.runId, {
            revisionId: current.revisionId,
            sequence: current.sequence,
            revisionAccepted: false,
          });
          continue;
        }
        if (status === 409) {
          // the same revision with other content: never sent by this server unless something is wrong
          this.logger.error(`Cloud backup coverage for run ${current.runId} conflicts with what Frameleaf Cloud holds`);
          throw new Settled('rejected', errorText(error));
        }
        if (status === 400 || status === 413 || status === 422) {
          throw new Settled('rejected', errorText(error));
        }
        throw new Settled('retry', errorText(error));
      }
    }
    throw new Settled('retry', 'revision expired twice');
  }

  /** Begin the revision; when Frameleaf Cloud does not know the run, report it again first. */
  private async begin(
    target: ManagedBackupApi,
    report: CloudBackupCoverageReport,
    header: ReturnType<typeof backupCoverageRevisionInputSchema.parse>,
  ) {
    try {
      await this.cloud.beginCoverage(target, report.runId, header);
    } catch (error) {
      if (statusOf(error) !== 404 || !report.runReport || report.revisionAccepted) {
        throw error;
      }
      // An older Frameleaf Cloud also answers 404: the route itself is missing. Either way the run is told
      // again, then the header once more; a second 404 waits for a later try.
      const runReport = report.runReport as unknown as BackupRunReport;
      try {
        await this.cloud.reportRun(target, runReport);
      } catch (refused) {
        const code = statusOf(refused);
        if (runReport.manifestKey && (code === 400 || code === 422)) {
          await this.cloud.reportRun(target, { ...runReport, manifestKey: null });
          // the run is known without its manifest: inclusion can no longer be claimed against it
          throw new Settled('rebuild', 'legacy manifest key refused');
        }
        throw refused;
      }
      await this.cloud.beginCoverage(target, report.runId, header);
    }
  }

  private async settle(report: CloudBackupCoverageReport, outcome: Settled, now: Date) {
    const attempts = report.attempts + 1;
    try {
      switch (outcome.status) {
        case 'published': {
          await this.selection.updateCoverageReport(report.runId, {
            status: 'published',
            publishedAt: now,
            attempts,
            nextAttemptAt: null,
            lastError: null,
          });
          this.logger.log(`Cloud backup coverage for run ${report.runId} published`);
          return;
        }
        case 'rejected': {
          await this.selection.updateCoverageReport(report.runId, {
            status: outcome.message === 'expired' || outcome.message === 'another instance' ? 'expired' : 'rejected',
            attempts,
            nextAttemptAt: null,
            lastError: outcome.message,
          });
          this.logger.warn(`Cloud backup coverage for run ${report.runId} was not published: ${outcome.message}`);
          return;
        }
        case 'rebuild': {
          await this.rebuildWithoutSnapshot(report, attempts, now);
          return;
        }
        case 'retry': {
          const wait = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 10));
          await this.selection.updateCoverageReport(report.runId, {
            attempts,
            nextAttemptAt: new Date(now.getTime() + wait),
            lastError: outcome.message,
          });
          this.logger.warn(
            `Cloud backup coverage for run ${report.runId} not reported yet (${outcome.message}); trying again later`,
          );
          return;
        }
      }
    } catch (error) {
      this.logger.warn(`Could not record the cloud backup coverage outcome: ${errorText(error)}`);
    }
  }

  /**
   * Frameleaf Cloud knows the run only without its manifest key (an older Frameleaf Cloud), so a legacy
   * reference cannot bind: the same rows with unknown inclusion, under a fresh revision nobody has seen.
   */
  private async rebuildWithoutSnapshot(report: CloudBackupCoverageReport, attempts: number, now: Date) {
    const rows: BackupCoverageRow[] = report.pages.flatMap(
      (body) => (JSON.parse(body) as { rows: BackupCoverageRow[] }).rows,
    );
    const bodies = backupCoverageBodies({
      sequence: report.sequence,
      inventoryAt: new Date(report.inventoryAt as unknown as string).toISOString(),
      snapshot: null,
      rows: rows.map((row) => ({ ...row, includedOriginals: null })),
    });
    await this.selection.updateCoverageReport(report.runId, {
      revisionId: bodies.header.revisionId,
      snapshot: null,
      pages: bodies.pages,
      runReport: { ...(report.runReport ?? {}), manifestKey: null },
      revisionAccepted: false,
      attempts,
      nextAttemptAt: now,
      lastError: 'legacy manifest key refused',
    });
  }
}
