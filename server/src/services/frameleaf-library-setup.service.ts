import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { AdminConfigDto } from 'src/dtos/config.dto.js';
import { LibrarySetupProgressDto } from 'src/dtos/frameleaf-library-setup.dto.js';
import { FrameleafWorker, JobName, MediaOperationKind, QueueName, SyncEntityType, UserStatus } from 'src/enum.js';
import { readImportedSetupRun } from 'src/library-import/setup-run.js';
import { RunHolds } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { type MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { SyncCheckpointRepository } from 'src/repositories/sync-checkpoint.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { LibraryScanService } from 'src/services/library-scan.service.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { SystemConfigService } from 'src/services/system-config.service.js';
import { readAliasedEnv } from 'src/utils/env-aliases.js';
import { parseScanResult } from 'src/utils/media-health-operation.js';
import { fromAck } from 'src/utils/sync.js';

type SetupState = {
  installation: string;
  origin: 'new_import' | 'new_library' | 'restored_library';
  phase: 'awaiting-account' | 'rescanning' | 'verifying' | 'needs-attention' | 'complete';
  startedAt: string;
  /** Retained separately from the mutable run marker for queue recovery. */
  importRunId?: string;
  importOperationId?: string;
  failedBaseline?: Record<string, number>;
  libraries: string[];
  scans: Record<string, string>;
  revision: string | null;
  quietSince: number | null;
  health: Record<string, string>;
  owners: string[];
  healthAfter: string | null;
  processingChoiceApplied?: boolean;
  /** FL-1146: the owner paused setup from the setup bar. */
  paused?: boolean;
  /** The run's Jobs release (`releasedAt`) seen when the owner last paused; a newer one wins over the pause. */
  pauseSeenRelease?: string | null;
  /** FL-1265: queues resumed in Jobs while setup was paused; their stages run anyway. Pausing again clears it. */
  resumedQueues?: string[];
  /**
   * FL-1265: a library scan or a file check ended early (failed or cancelled), or one of their jobs failed. Reported,
   * never a stop: setup carries on and Retry checks again.
   */
  checkProblem?: boolean;
  /** FL-1146: when the original-file check finished and the stages that wait for it were released. */
  checkReleasedAt?: string | null;
  /** FL-1146: when everything finished, for the one-time completion window. */
  completedAt?: string | null;
  /**
   * Scans a paused setup held when it was retried. The retry starts its own, and resuming resumes these too: left
   * paused, one would hold the file check with nothing left to resume it.
   */
  heldScans?: string[];
  /** File checks an earlier attempt left stopped, by owner: a retry carries each on from where it stopped. */
  resumeHealth?: Record<string, string>;
  /**
   * The owner dismissed setup to let the server run: held work is released, the bar and the phone step go away,
   * and nothing halts on setup's account. Background work and Library Care still list what needs a look.
   */
  dismissedAt?: string | null;
};
type PhoneState = { revision: string; tokenHash: string; finished: boolean };
const SETUP_QUEUES = [
  QueueName.Library,
  QueueName.Sidecar,
  QueueName.MetadataExtraction,
  QueueName.ThumbnailGeneration,
  QueueName.VideoConversion,
  QueueName.MediaHealth,
];
/**
 * FL-1165: the queues whose failures are reported as a check problem. A thumbnail, metadata, sidecar or video job that
 * fails on one damaged original is listed in Background work and Library Care like the original itself (FL-1146).
 * FL-1265: these are reported too, never a stop.
 */
const HALTING_QUEUES = new Set<QueueName>([QueueName.Library, QueueName.MediaHealth]);
const KEY = 'frameleaf-manager-library-setup';
/**
 * FL-1146 (owner 2026-11-02): an import opens before its originals are read. Metadata and thumbnails start at
 * once; the stages below wait for Library Care's checksum scan of every original, then start by themselves.
 */
const EARLY_STAGES: string[] = [JobName.AssetExtractMetadata, JobName.AssetGenerateThumbnails];
/** The setup bar's later stage: the heavy work that waits for the file check, and that quiet hours save for the night. */
const SEARCH_STAGES: string[] = [JobName.SmartSearch, JobName.AssetDetectFaces, JobName.AssetEncodeVideo];
/** The setup bar's early stage: what starts with the file check. */
const THUMBNAIL_STAGES: string[] = [...EARLY_STAGES, JobName.PersonGenerateThumbnail];
const phoneKey = (sessionId: string) => `:phone:${sessionId}`;
/**
 * Every held stage may run: the file check ended, the owner dismissed setup to let the server run, or an administrator
 * released the run from Jobs.
 */
const released = (state: SetupState, selection: SetupSelection) =>
  !!state.checkReleasedAt || !!state.dismissedAt || !!selection.releasedAt;
type SetupSelection = NonNullable<NonNullable<Awaited<ReturnType<typeof readImportedSetupRun>>>['run']>['selection'];
const ENDED = new Set(['completed', 'failed', 'cancelled']);

/**
 * FL-1265: what should hold each stage of the import's run, recomputed on every poll. Before first setup starts every
 * stage waits; a pause holds what has not started (a queue resumed in Jobs runs anyway); until the file check ends
 * only the early stages run; after it, a stage whose machine learning is off and that was still held is parked, so
 * the run settles without it, and runs again when machine learning is switched on.
 */
const desiredHolds = (
  state: SetupState,
  selection: SetupSelection,
  stages: readonly string[],
  disabled: string[],
  queueOf: (stage: string) => string,
): RunHolds => {
  const holds: RunHolds = {};
  const current = selection.holds ?? {};
  const releaseWins = !!selection.releasedAt && selection.releasedAt !== state.pauseSeenRelease;
  for (const stage of stages) {
    if (!selection.managerSetup?.startedAt && !selection.releasedAt) {
      holds[stage] = 'setup';
    } else if (state.paused && !releaseWins && !state.resumedQueues?.includes(queueOf(stage))) {
      holds[stage] = 'paused';
    } else if (!released(state, selection) && !EARLY_STAGES.includes(stage)) {
      holds[stage] = 'setup';
    } else if (disabled.includes(stage) && current[stage] !== undefined) {
      holds[stage] = 'parked';
    }
  }
  return holds;
};
const sameHolds = (a: RunHolds, b: RunHolds = {}) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([stage, hold]) => b[stage] === hold);
/** Library Care's full check of an account: every original, not only recent changes or chosen photos. */
const fullScan = (table: string) =>
  sql`${sql.ref(`${table}.kind`)}='media_health' AND ${sql.ref(`${table}.snapshot`)}->>'mode'='scan'
    AND NOT (${sql.ref(`${table}.snapshot`)} ? 'changedSince') AND NOT (${sql.ref(`${table}.snapshot`)} ? 'assetIds')`;

/** Additive API: the existing photo, setup and synchronization endpoints keep their contracts. */
@Injectable()
export class FrameleafLibrarySetupService {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<unknown>;
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private libraries: LibraryRepository,
    private scans: LibraryScanService,
    private jobs: JobRepository,
    private users: UserRepository,
    private checkpoints: SyncCheckpointRepository,
    private mediaHealth: MediaHealthService,
    private config: SystemConfigService,
    private operations: MediaOperationRepository,
  ) {}

  private identity() {
    const installation = process.env.FRAMELEAF_MANAGER_INSTALLATION;
    const origin = process.env.FRAMELEAF_MANAGER_ORIGIN;
    if (
      !installation ||
      !/^[a-f0-9]{12}$/.test(installation) ||
      !['new_import', 'new_library', 'restored_library'].includes(origin ?? '')
    ) {
      throw new BadRequestException('This library was not provisioned by Frameleaf Manager');
    }
    return { installation, origin: origin as SetupState['origin'] };
  }

  private key() {
    return `${KEY}:${this.identity().installation}`;
  }

  private async locked<T>(work: (db: Kysely<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (db) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${KEY}, 0))`.execute(db);
      return work(db);
    });
  }

  private async setupOwners(db: Kysely<DB>): Promise<string[]> {
    const owners = await db
      .selectFrom('user')
      .select('id')
      .where('deletedAt', 'is', null)
      .union(db.selectFrom('asset').select('ownerId as id').distinct())
      .execute();
    return owners.map(({ id }) => id);
  }

  private async read<T>(key: string, db = this.db): Promise<T | null> {
    const result = await sql<{ value: T }>`SELECT value FROM system_metadata WHERE key = ${key}`.execute(db);
    return result.rows[0]?.value ?? null;
  }

  private async write(key: string, value: unknown, db = this.db) {
    await sql`INSERT INTO system_metadata (key, value) VALUES (${key}, ${JSON.stringify(value)}::text::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`.execute(db);
  }

  /** Manager-only machine credential, mounted read-only; never an administrator or mobile session. */
  async authorizeManager(token: string | undefined): Promise<void> {
    this.identity();
    const path = process.env.FRAMELEAF_MANAGER_TOKEN_FILE;
    if (path !== '/run/frameleaf/manager-token' || !token || !/^[a-f0-9]{64}$/.test(token)) {
      throw new ForbiddenException();
    }
    const expected = (await readFile(path, 'utf8')).trim();
    if (expected.length !== token.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(token))) {
      throw new ForbiddenException();
    }
  }

  async begin(retry = false): Promise<void> {
    const identity = this.identity();
    let retriedImportedWork = false;
    await this.locked(async (db) => {
      const previous = await this.read<SetupState>(this.key(), db);
      // Retrying a stopped setup, one whose check ended early, or one the owner dismissed (in any phase, finished
      // included), checks again.
      const reopened = retry && !!previous?.dismissedAt;
      const retrying = retry && (previous?.phase === 'needs-attention' || !!previous?.checkProblem);
      if (previous && previous.phase !== 'awaiting-account' && !retrying && !reopened) {
        await this.startImportedRegeneration(previous, db);
        return;
      }
      if (retrying) {
        const imported = await this.importedRun(db, true);
        if (
          this.importedSetupMatches(previous, imported) &&
          imported?.journal.status === 'activated' &&
          imported.run?.enumerationDone &&
          imported.run.selection.managerSetup?.startedAt
        ) {
          await this.jobs.retryImportedWork(imported.run.id, db);
          retriedImportedWork = true;
        }
      }
      const ml = process.env.FRAMELEAF_MANAGER_ML_ENABLED;
      let processingChoiceApplied = previous?.processingChoiceApplied ?? false;
      if (
        (!previous || (identity.origin === 'new_import' && !processingChoiceApplied)) &&
        identity.origin !== 'restored_library' &&
        ml !== undefined
      ) {
        if (!['true', 'false'].includes(ml)) {
          throw new BadRequestException('Invalid Manager processing choice');
        }
        const { config, revision } = await this.config.getAdminConfigWithRevision();
        config.machineLearning.enabled = ml === 'true';
        config.machineLearning.urls = ['http://frameleaf-machine-learning:3003'];
        await this.config.updateAdminConfigWithRevision({ config, expectedRevision: revision });
        processingChoiceApplied = true;
      }
      // An imported server that read its settings from a file keeps that file: Manager writes the processing choice
      // into it and passes no FRAMELEAF_MANAGER_ML_ENABLED, so the choice is already applied.
      if (identity.origin === 'new_import' && ml === undefined && readAliasedEnv('FRAMELEAF_CONFIG_FILE')) {
        processingChoiceApplied = true;
      }
      const hasAdmin = await this.users.hasAdmin();
      const libraries = hasAdmin ? await this.libraries.getAll() : [];
      // Every account, including one whose photos survive only as untracked files in its upload folder.
      const owners = hasAdmin ? await this.setupOwners(db) : [];
      // Commit intent independently of queue submission so a process restart can resume it.
      const state: SetupState = {
        ...identity,
        phase:
          hasAdmin && (identity.origin !== 'new_import' || processingChoiceApplied) ? 'rescanning' : 'awaiting-account',
        startedAt: new Date().toISOString(),
        libraries: libraries.map((l) => l.id),
        scans: {},
        health: {},
        owners,
        // A retry keeps the owner's pause and what the file check already released (FL-1146).
        paused: previous?.paused,
        pauseSeenRelease: previous?.pauseSeenRelease,
        resumedQueues: previous?.resumedQueues,
        heldScans: previous?.paused
          ? [
              ...new Set([
                ...(previous.heldScans ?? []),
                ...Object.values(previous.scans),
                ...Object.values(previous.health),
              ]),
            ]
          : undefined,
        // Kept until each owner's new check starts; a check never started keeps its predecessor's place.
        resumeHealth: previous ? { ...previous.resumeHealth, ...previous.health } : undefined,
        dismissedAt: retry ? null : (previous?.dismissedAt ?? null),
        importRunId: previous?.importRunId,
        importOperationId: previous?.importOperationId,
        // Checking a reopened library again starts from no finished check and no completion; stages its dismissal
        // released stay released unless the owner pauses.
        checkReleasedAt: reopened ? null : (previous?.checkReleasedAt ?? null),
        completedAt: reopened ? null : (previous?.completedAt ?? null),
        healthAfter: null,
        revision: null,
        quietSince: null,
        processingChoiceApplied,
        failedBaseline: Object.fromEntries(
          await Promise.all(
            SETUP_QUEUES.map(async (queue) => [queue, (await this.jobs.getJobCounts(queue)).failed] as const),
          ),
        ),
      };
      await this.write(this.key(), state, db);
      await this.startImportedRegeneration(state, db);
    });
    // Committed now: Activity's next read must not reuse counts from before the retry.
    if (retriedImportedWork) this.jobs.forgetRunReads();
  }

  private importedRun(db = this.db, lock = false) {
    return readImportedSetupRun(db, lock);
  }

  /** Restored authority comes only from Manager's private, reviewed canonical recovery metadata. */
  private importInstallation(state: SetupState): string | null {
    if (state.origin === 'new_import') return state.installation;
    const installation = process.env.FRAMELEAF_MANAGER_IMPORT_INSTALLATION;
    return state.origin === 'restored_library' && installation && /^[a-f0-9]{12}$/.test(installation)
      ? installation
      : null;
  }

  private importedSetupRequired(state: SetupState, imported: Awaited<ReturnType<typeof readImportedSetupRun>>) {
    return (
      !!this.importInstallation(state) ||
      imported?.run?.selection.managerSetupRequired !== undefined ||
      imported?.run?.selection.managerSetup !== undefined
    );
  }

  private importedSetupMatches(state: SetupState, imported: Awaited<ReturnType<typeof readImportedSetupRun>>) {
    const installation = this.importInstallation(state);
    return (
      !!installation &&
      !!imported?.identityMatches &&
      imported.run?.selection.managerSetup?.installation === installation &&
      (state.importRunId === undefined || state.importRunId === imported.run.id) &&
      (state.importOperationId === undefined ||
        state.importOperationId === imported.run.selection.managerSetup.operationId)
    );
  }

  private async processingSettingsReady(state: SetupState): Promise<boolean> {
    if (state.origin === 'new_import') return !!state.processingChoiceApplied;
    if (state.origin !== 'restored_library') return false;
    try {
      // Read the effective restored configuration, including file authority, without overwriting it.
      const { config } = await this.config.getAdminConfigWithRevision();
      return AdminConfigDto.schema.safeParse(config).success;
    } catch {
      return false;
    }
  }

  private async startImportedRegeneration(state: SetupState, db: Kysely<DB>) {
    const installation = this.importInstallation(state);
    if (!installation || !(await this.users.hasAdmin()) || !(await this.processingSettingsReady(state))) return;
    const current = await this.importedRun(db);
    if (
      this.importedSetupMatches(state, current) &&
      current?.run?.selection.managerSetup &&
      (state.importRunId === undefined || state.importOperationId === undefined)
    ) {
      state.importRunId = current.run.id;
      state.importOperationId = current.run.selection.managerSetup.operationId;
      await this.write(this.key(), state, db);
    }
    if (
      this.importedSetupMatches(state, current) &&
      current?.journal.status === 'activated' &&
      current.run?.enumerationDone &&
      current.run.selection.managerSetup?.startedAt &&
      current.run.selection.managerSetup.paused === !!state.paused &&
      current.run.selection.managerSetupRequired === true
    )
      return this.applyHolds(state, db);
    const imported = await this.importedRun(db, true);
    if (!imported) return;
    const { journal, run } = imported;
    const marker = run?.selection.managerSetup;
    if (
      journal.status !== 'activated' ||
      !run ||
      !this.importedSetupMatches(state, imported) ||
      marker?.installation !== installation ||
      !marker.operationId ||
      !marker.preparedAt ||
      !run.enumerationDone
    )
      return;
    await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,paused}',${JSON.stringify(!!state.paused)}::text::jsonb) || '{"managerSetupRequired":true}'::jsonb
      WHERE id=${run.id}::uuid AND (selection #> '{managerSetup,paused}' IS DISTINCT FROM ${JSON.stringify(!!state.paused)}::text::jsonb
        OR selection->'managerSetupRequired' IS DISTINCT FROM 'true'::jsonb)`.execute(db);
    if (!marker.startedAt) {
      if (state.origin === 'restored_library') {
        const summary = await this.jobs.getRun(run.id);
        if (
          !summary ||
          ['completed', 'cancelled', 'completed_with_errors', 'needs_attention'].includes(summary.state)
        ) {
          return;
        }
      }
      // Prepared (every stage inserted, held) and activated: first setup starts the run.
      await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,startedAt}',${JSON.stringify(new Date().toISOString())}::text::jsonb)
        WHERE id=${run.id}::uuid`.execute(db);
    }
    await this.applyHolds(state, db, true);
  }

  /**
   * FL-1265: writes the holds this setup wants on its import's run (see `desiredHolds`) when they differ from the
   * stored ones. It reads first, so a poll with nothing to change takes no run lock. Nothing is written before first
   * setup starts the run (the run keeps preparation's holds) or for a run this setup does not match.
   */
  private async applyHolds(state: SetupState, db: Kysely<DB>, locked = false): Promise<void> {
    const imported = await this.importedRun(db, locked);
    const run = imported?.run;
    if (!imported || !run?.selection.managerSetup?.startedAt || !this.importedSetupMatches(state, imported)) return;
    const holds = desiredHolds(state, run.selection, imported.stages, await this.disabledImportStages(), (stage) =>
      this.jobs.getQueueName(stage as JobName),
    );
    if (sameHolds(holds, run.selection.holds)) return;
    if (!locked) return this.applyHolds(state, db, true);
    await this.jobs.setRunHolds(run.id, holds, db);
  }

  private async regenerationStatus(state: SetupState) {
    if (state.origin === 'new_library') return null;
    const imported = await this.importedRun();
    const run = imported?.run;
    const marker = run?.selection.managerSetup;
    const installation = this.importInstallation(state);
    // Canonical fresh/independent-copy libraries have no Manager-held import to recover.
    if (
      state.origin === 'restored_library' &&
      !marker &&
      !installation &&
      run?.selection.managerSetupRequired === undefined
    )
      return null;
    const matches = !!run && this.importedSetupMatches(state, imported);
    const summary = matches ? await this.jobs.getRun(run.id) : null;
    const pending =
      !!marker &&
      !marker.startedAt &&
      !['completed', 'cancelled', 'completed_with_errors', 'needs_attention'].includes(summary?.state ?? '');
    const settingsReady = await this.processingSettingsReady(state);
    return {
      runId: run?.id ?? null,
      state: matches ? (pending ? 'pending_first_setup' : (summary?.state ?? 'unavailable')) : 'needs_attention',
      preparedAt: marker?.preparedAt ?? null,
      startedAt: marker?.startedAt ?? null,
      completed: summary?.completed ?? 0,
      total: summary?.total ?? 0,
      failed: summary?.failed ?? 0,
      blocked: summary?.blocked ?? 0,
      needsAttention: summary?.needsAttention ?? 0,
      reasons: matches
        ? pending
          ? [
              settingsReady
                ? imported?.journal.status === 'activated'
                  ? marker.preparedAt
                    ? state.phase === 'awaiting-account'
                      ? 'account_not_ready'
                      : 'first_setup_pending'
                    : 'snapshot_not_prepared'
                  : 'import_not_activated'
                : 'settings_not_ready',
            ]
          : (summary?.reasons ?? [])
        : ['import_not_prepared'],
    };
  }

  private async disabledImportStages() {
    const {
      config: { machineLearning },
    } = await this.config.getAdminConfigWithRevision();
    return [
      ...(!machineLearning.enabled || !machineLearning.clip.enabled ? [JobName.SmartSearch] : []),
      ...(!machineLearning.enabled || !machineLearning.facialRecognition.enabled ? [JobName.AssetDetectFaces] : []),
    ];
  }

  /**
   * FL-1146 setup bar: what an imported library still has to do after it opens. Null when this server was not
   * set up from an import, or before its first setup started.
   */
  async progress(): Promise<LibrarySetupProgressDto> {
    const inactive = {
      active: false,
      phase: null,
      paused: false,
      completedAt: null,
      items: 0,
      people: 0,
      albums: 0,
      flagged: 0,
      stages: [],
    };
    let identity;
    try {
      identity = this.identity();
    } catch {
      return inactive;
    }
    if (identity.origin === 'new_library') return inactive;
    const state = await this.read<SetupState>(this.key());
    if (!state || state.phase === 'awaiting-account' || state.dismissedAt) return inactive;
    const imported = await this.importedRun();
    if (this.importedSetupRequired(state, imported) && !this.importedSetupMatches(state, imported))
      return { ...inactive, active: true, phase: 'needs-attention', paused: !!state.paused };
    const run =
      this.importedSetupMatches(state, imported) && imported?.run?.selection.managerSetup?.startedAt
        ? imported.run
        : null;
    const disabled = run ? await this.disabledImportStages() : [];
    // Settled, not only completed: an item's failure is listed in Background work and never holds setup (FL-1165).
    const stages = run
      ? (await this.jobs.getRunStageProgress(run.id))
          .filter(({ name }) => !disabled.includes(name))
          .map(({ name, queue, total, done }) => ({ stage: name as string, queue: queue as string, total, done }))
      : [];
    const sum = (names: string[]) => {
      const part = { total: 0, done: 0 };
      for (const row of stages) {
        if (names.includes(row.stage)) {
          part.total += row.total;
          part.done += row.done;
        }
      }
      return part;
    };
    const healthIds = Object.values(state.health);
    const {
      rows: [check],
    } = await sql<{ total: number; done: number; flagged: number }>`SELECT
        -- The health runs count only once a scan ends; the operation carries the live count. A scan still
        -- waiting its turn (one runs at a time) counts its owner's items, so the bar never looks nearly done.
        coalesce(sum(greatest(op."totalUnits", corrupt."totalAssets", CASE WHEN op."totalUnits" IS NULL THEN
          (SELECT count(*) FROM asset a WHERE a."ownerId"=op."ownerId" AND a."deletedAt" IS NULL) END)),0)::int AS total,
        coalesce(sum(greatest(op."processedUnits", corrupt."checkedAssets")),0)::int AS done,
        (coalesce(sum(corrupt."foundAssets"),0) + coalesce(sum(missing."foundAssets"),0))::int AS flagged
      FROM media_operation op
      LEFT JOIN asset_health_run missing ON missing.id=(op.snapshot->>'missingRunId')::uuid
      LEFT JOIN asset_health_run corrupt ON corrupt.id=(op.snapshot->>'corruptRunId')::uuid
      WHERE op.id=ANY(${healthIds}::uuid[])`.execute(this.db);
    const {
      rows: [{ items, people, albums }],
    } = await sql<{ items: number; people: number; albums: number }>`SELECT
      (SELECT count(*) FROM asset WHERE "deletedAt" IS NULL)::int AS items,
      (SELECT count(*) FROM person WHERE name <> '')::int AS people,
      (SELECT count(*) FROM album WHERE "deletedAt" IS NULL)::int AS albums`.execute(this.db);
    const thumbnails = sum(THUMBNAIL_STAGES);
    const search = sum(SEARCH_STAGES);
    const checked = !!state.checkReleasedAt;
    const night = checked && !state.paused && search.done < search.total ? await this.heldForNight(stages) : null;
    const status = (part: { total: number; done: number }, released: boolean) =>
      (part.total > 0 || (run?.enumerationDone && state.phase === 'complete')) && part.done >= part.total
        ? 'done'
        : !released
          ? 'waiting'
          : state.paused
            ? 'paused'
            : 'running';
    const finished =
      state.phase === 'complete' && checked && search.done >= search.total && thumbnails.done >= thumbnails.total;
    if (finished && !state.completedAt) {
      await this.locked(async (db) => {
        const current = (await this.read<SetupState>(this.key(), db))!;
        // Only the setup observed above: a retry or reopen since (a new startedAt) or a dismissal is not finished.
        if (current.startedAt !== state.startedAt || current.phase !== 'complete' || current.dismissedAt) return;
        state.completedAt = current.completedAt ?? new Date().toISOString();
        await this.write(this.key(), { ...current, completedAt: state.completedAt }, db);
      });
    }
    return {
      active: true,
      phase: state.phase,
      paused: !!state.paused,
      checkProblem: !!state.checkProblem,
      completedAt: state.completedAt ?? null,
      items,
      people,
      albums,
      flagged: check?.flagged ?? 0,
      stages: [
        {
          id: 'check' as const,
          status: checked ? ('done' as const) : state.paused ? ('paused' as const) : ('running' as const),
          done: checked ? (check?.total ?? 0) : (check?.done ?? 0),
          total: check?.total ?? 0,
        },
        { id: 'thumbnails' as const, status: status(thumbnails, !!run), ...thumbnails },
        {
          id: 'search' as const,
          // With AI processing off only videos are left in this stage; with none, it has nothing to wait for.
          status:
            (disabled.length === 2 && search.total === 0) || night
              ? ('waiting' as const)
              : status(search, !!run && checked),
          disabled: disabled.length === 2,
          ...(night && { heldForNight: true, resumesAt: night.resumesAt }),
          ...search,
        },
      ],
    };
  }

  /**
   * FL-577: quiet hours close the search stage's queues outside the overnight window. When every queue that still
   * holds some of its work is closed, the bar says when it starts again instead of "In progress".
   */
  private async heldForNight(rows: { stage: string; queue: string; total: number; done: number }[]) {
    const queues = new Set(
      rows.filter((row) => SEARCH_STAGES.includes(row.stage) && row.done < row.total).map((row) => row.queue),
    );
    let resumesAt: number | null = null;
    for (const queue of queues) {
      // FL-1265: a queue an administrator resumed during the day has no schedule left.
      const closedUntil = (await this.jobs.getQueueSchedule(queue as QueueName))?.getTime();
      if (closedUntil === undefined || !(closedUntil > Date.now())) return null;
      resumesAt = Math.min(resumesAt ?? closedUntil, closedUntil);
    }
    if (queues.size === 0) return null;
    return { resumesAt: resumesAt !== null && Number.isFinite(resumesAt) ? new Date(resumesAt).toISOString() : null };
  }

  /** FL-1146: Pause holds new work and Library Care's scans at their next checkpoint; nothing is lost. */
  async setPaused(paused: boolean): Promise<LibrarySetupProgressDto> {
    this.identity();
    const changed: (MediaOperation | undefined)[] = [];
    await this.locked(async (db) => {
      const state = await this.read<SetupState>(this.key(), db);
      if (!state || !!state.paused === paused) return;
      await this.applyPause(state, paused, changed, db);
      await this.write(this.key(), state, db);
    });
    for (const row of changed) this.operations.notifyCancellation(row);
    return this.progress();
  }

  /**
   * Pauses or resumes setup's held stages and scans; the caller holds the setup lock and writes `state`. Refused,
   * changing nothing, when the import no longer matches this setup.
   */
  private async applyPause(
    state: SetupState,
    paused: boolean,
    changed: (MediaOperation | undefined)[],
    db: Kysely<DB>,
  ) {
    const imported = await this.importedRun(db, true);
    if (this.importedSetupRequired(state, imported) && !this.importedSetupMatches(state, imported))
      throw new BadRequestException('Imported setup identity mismatch');
    state.paused = paused;
    state.pauseSeenRelease = paused ? (imported?.run?.selection.releasedAt ?? null) : undefined;
    state.resumedQueues = undefined;
    if (this.importedSetupMatches(state, imported) && imported?.run) {
      await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,paused}',${JSON.stringify(paused)}::text::jsonb)
        WHERE id=${imported.run.id}::uuid`.execute(db);
    }
    // Held items stay where they are: running jobs finish, and no new ones start.
    await this.applyHolds(state, db, true);
    for (const [ownerId, operationId] of Object.entries(state.health)) {
      changed.push(
        await (paused
          ? this.operations.requestPause(operationId, ownerId, [MediaOperationKind.MediaHealth], db)
          : this.operations.resume(operationId, ownerId, db)),
      );
    }
    const { rows: scans } = await sql<{ id: string; ownerId: string }>`SELECT id,"ownerId" FROM media_operation
      WHERE id=ANY(${[...new Set(Object.values(state.scans))]}::uuid[]) AND kind=${MediaOperationKind.LibraryScan} FOR UPDATE`.execute(
      db,
    );
    for (const scan of scans) {
      changed.push(
        await (paused
          ? this.operations.requestPause(scan.id, scan.ownerId, [MediaOperationKind.LibraryScan], db)
          : this.operations.resume(scan.id, scan.ownerId, db)),
      );
    }
    if (!paused && state.heldScans?.length) {
      const { rows: held } = await sql<{ id: string; ownerId: string }>`SELECT id,"ownerId" FROM media_operation
        WHERE id=ANY(${state.heldScans}::uuid[]) FOR UPDATE`.execute(db);
      for (const scan of held) changed.push(await this.operations.resume(scan.id, scan.ownerId, db));
      state.heldScans = undefined;
    }
  }

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    if (!process.env.FRAMELEAF_MANAGER_INSTALLATION) {
      return;
    }
    this.timer ??= setInterval(() => {
      if (!this.active) {
        this.active = this.status()
          .catch(() => {})
          .finally(() => {
            this.active = undefined;
          });
      }
    }, 10_000);
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.active;
  }

  /** FL-1265: resuming a queue in Jobs runs its import work even while setup stays paused. */
  @OnEvent({ name: 'QueueResumed' })
  async onQueueResumed({ queue }: ArgOf<'QueueResumed'>) {
    let key;
    try {
      key = this.key();
    } catch {
      return; // not a Manager-provisioned server
    }
    await this.locked(async (db) => {
      const state = await this.read<SetupState>(key, db);
      if (!state?.paused || state.resumedQueues?.includes(queue)) return;
      state.resumedQueues = [...(state.resumedQueues ?? []), queue];
      await this.write(key, state, db);
      await this.applyHolds(state, db, true);
    });
  }

  private async advance(): Promise<SetupState> {
    await this.begin();
    return this.locked(async (db) => {
      const state = (await this.read<SetupState>(this.key(), db))!;
      // FL-1265: needs-attention is informational and found again on every poll (only an import that no longer matches
      // sets it now), so one saved by an older server, or by a mismatch since put right, carries on.
      if (state.phase === 'needs-attention') state.phase = 'rescanning';
      if (state.phase === 'rescanning' || state.phase === 'verifying') {
        const boundImport = await this.importedRun(db);
        if (this.importedSetupRequired(state, boundImport) && !this.importedSetupMatches(state, boundImport)) {
          state.phase = 'needs-attention';
          await this.write(this.key(), state, db);
          return state;
        }
        const admin = await this.users.getAdmin();
        if (!admin) {
          return state;
        }
        for (const libraryId of state.libraries) {
          const library = await this.libraries.get(libraryId);
          // A library deleted since setup began, or whose owner's account was deleted, holds nothing to wait for, nor
          // does its scan, which stopped with it (LibraryScanService.onUserTrash).
          const {
            rows: [owner],
          } = library
            ? await sql<{ active: boolean }>`SELECT "deletedAt" IS NULL AND status=${UserStatus.Active} AS active
                FROM "user" WHERE id=${library.ownerId}::uuid`.execute(db)
            : { rows: [] };
          if (!library || !owner?.active) {
            state.libraries = state.libraries.filter((id) => id !== libraryId);
            delete state.scans[libraryId];
            continue;
          }
          if (state.scans[libraryId]) {
            continue;
          }
          // Reuse a queued scan whose acknowledgement was lost, including a completed one.
          const existing = await sql<{ id: string }>`SELECT id FROM media_operation WHERE kind='library_scan'
            AND snapshot->>'libraryId'=${libraryId} AND "createdAt" >= ${state.startedAt}::timestamptz
            ORDER BY "createdAt" LIMIT 1`.execute(db);
          if (state.paused && !existing.rows[0]) {
            continue; // A paused setup admits no new library scan; resuming admits it.
          }
          try {
            state.scans[libraryId] =
              existing.rows[0]?.id ??
              (await this.scans.queue(library, { ownerId: admin.id, trigger: 'manual' })).operation.id;
          } catch (error) {
            // Nothing to scan: an imported library with no folder, or one whose owner's account is deleted.
            // Refused on every try, it would otherwise hold setup for good.
            if (!(error instanceof BadRequestException)) throw error;
            state.libraries = state.libraries.filter((id) => id !== libraryId);
          }
        }
        const ids = Object.values(state.scans);
        const records =
          ids.length > 0
            ? await sql<{
                id: string;
                status: string;
              }>`SELECT id,status FROM media_operation WHERE id=ANY(${ids}::uuid[])`.execute(db)
            : { rows: [] };
        // FL-1265: a scan that failed or was cancelled has ended too; what it imported is processed, and the problem is
        // reported (Retry scans again).
        const scansFinished = state.libraries.every((id) =>
          records.rows.some((r) => r.id === state.scans[id] && ENDED.has(r.status)),
        );
        let checkProblem = records.rows.some((record) => ['failed', 'cancelled'].includes(record.status));
        if (scansFinished && !state.healthAfter) {
          // Commit full-scan admission after external discovery. The following call can safely
          // recover a lost queue acknowledgement, and must cover the resulting inventory.
          state.healthAfter = new Date().toISOString();
          state.owners = await this.setupOwners(db);
          await this.write(this.key(), state, db);
          return state;
        }
        // Library Care's durable full scan covers managed uploads as well as external files,
        // including original-file integrity. Reuse its operation after a lost acknowledgement.
        // A paused setup starts no new scan; resuming starts it.
        if (scansFinished) {
          // An account removed since the check began has no originals left to check, nor its scan.
          const { rows: live } = await sql<{
            id: string;
          }>`SELECT id FROM "user" WHERE id=ANY(${state.owners}::uuid[])`.execute(db);
          state.owners = state.owners.filter((id) => live.some((row) => row.id === id));
          // A scan recorded that is not the account's full check (one of chosen photos adopted before they were told
          // apart, or one gone since) is forgotten, so a full check starts in its place.
          const recorded = Object.values(state.health);
          const { rows: full } =
            recorded.length > 0
              ? await sql<{ id: string }>`SELECT id FROM media_operation WHERE id=ANY(${recorded}::uuid[])
                AND ${fullScan('media_operation')} AND "createdAt" >= ${state.healthAfter}::timestamptz`.execute(db)
              : { rows: [] };
          for (const [ownerId, id] of Object.entries(state.health)) {
            if (full.every((row) => row.id !== id)) delete state.health[ownerId];
          }
        }
        if (scansFinished && !state.paused) {
          for (const ownerId of state.owners) {
            if (state.health[ownerId]) {
              continue;
            }
            const existing = await sql<{ id: string }>`SELECT id FROM media_operation
            WHERE "ownerId"=${ownerId}::uuid AND ${fullScan('media_operation')}
            AND "createdAt" >= ${state.healthAfter}::timestamptz ORDER BY "createdAt" LIMIT 1`.execute(db);
            let operationId: string | null | undefined = existing.rows[0]?.id;
            try {
              operationId ??= (
                await this.mediaHealth.startMissingScan(
                  { user: { id: ownerId } } as AuthDto,
                  undefined,
                  await this.resumePoint(state.resumeHealth?.[ownerId], db),
                )
              ).operationId;
            } catch (error) {
              // Another kind of scan (recent changes, chosen photos, a search for originals) is under way for this
              // account: wait for it, as for an incompatible scan below.
              if (error instanceof ConflictException) continue;
              throw error;
            }
            if (!operationId) {
              throw new BadRequestException('Library integrity scan could not be queued');
            }
            const eligible = await sql<{ id: string }>`SELECT id FROM media_operation WHERE id=${operationId}::uuid
              AND "ownerId"=${ownerId}::uuid AND ${fullScan('media_operation')}
              AND "createdAt" >= ${state.healthAfter}::timestamptz`.execute(db);
            if (eligible.rows.length === 0) {
              continue; // Wait for an incompatible active scan before admitting ours.
            }
            state.health[ownerId] = operationId;
            delete state.resumeHealth?.[ownerId];
          }
        }
        const healthIds = Object.values(state.health);
        const health =
          healthIds.length > 0
            ? await sql<{ id: string; status: string; verified: boolean; problems: boolean }>`
          SELECT op.id, op.status,
            (missing.status='completed' AND corrupt.status='completed') AS verified,
            (missing."foundAssets">0 OR corrupt."foundAssets">0) AS problems
          FROM media_operation op
          LEFT JOIN asset_health_run missing ON missing.id=(op.snapshot->>'missingRunId')::uuid
          LEFT JOIN asset_health_run corrupt ON corrupt.id=(op.snapshot->>'corruptRunId')::uuid
          WHERE op.id=ANY(${healthIds}::uuid[]) AND ${fullScan('op')}
            AND op."createdAt" >= ${state.healthAfter}::timestamptz`.execute(db)
            : { rows: [] };
        // FL-1146: a missing or changed original is kept and listed in Library Care; it never stops setup.
        // FL-1265: nor does a check that failed or was cancelled: it has ended, it is reported, and Retry carries it on.
        checkProblem ||= health.rows.some(
          (record) =>
            ['failed', 'cancelled'].includes(record.status) || (record.status === 'completed' && !record.verified),
        );
        const healthFinished = state.owners.every((id) =>
          health.rows.some((record) => record.id === state.health[id] && ENDED.has(record.status)),
        );
        if (scansFinished && healthFinished && !state.checkReleasedAt && !state.paused) {
          state.checkReleasedAt = new Date().toISOString();
          await this.applyHolds(state, db, true);
        }
        // Sidecar completion enqueues metadata, which enqueues derivatives. An idle downstream
        // queue alone cannot establish a final sync revision.
        const queues = await Promise.all(SETUP_QUEUES.map((q) => this.jobs.getJobCounts(q)));
        checkProblem ||= queues.some(
          (q, i) => HALTING_QUEUES.has(SETUP_QUEUES[i]) && q.failed > (state.failedBaseline?.[SETUP_QUEUES[i]] ?? 0),
        );
        state.checkProblem = checkProblem;
        const idle = queues.every((q) => q.active === 0 && q.waiting === 0 && q.delayed === 0 && q.paused === 0);
        let importedUnfinished = false;
        if (this.importedSetupRequired(state, boundImport)) {
          // Lock before the fresh pending-work read: idle queues do not account for unadmitted run items.
          const imported = await this.importedRun(db, true);
          importedUnfinished = true;
          if (this.importedSetupMatches(state, imported) && imported?.run?.enumerationDone) {
            // A stage whose machine learning is off (parked, or waiting for it) does not keep setup open; held and
            // running work of every other stage does.
            const disabled = await this.disabledImportStages();
            importedUnfinished =
              disabled.length === 0
                ? await this.jobs.runHasLiveWork(imported.run.id, { ignoreParked: true }, db)
                : (
                    await sql<{ live: boolean }>`SELECT EXISTS(SELECT 1 FROM job WHERE "runId"=${imported.run.id}::uuid
                      AND state IN ('pending','waiting','active') AND name<>ALL(${disabled}::text[])) AS live`.execute(
                      db,
                    )
                  ).rows[0].live;
          }
        }
        // Setup is not complete until the file check has released the stages that wait for it, nor while a pause
        // holds them: held selections do not show in the queue counts.
        if (
          state.paused ||
          !scansFinished ||
          !healthFinished ||
          !idle ||
          importedUnfinished ||
          !state.checkReleasedAt
        ) {
          state.quietSince = null;
        } else {
          state.phase = 'verifying';
          state.quietSince ??= Date.now();
          if (Date.now() - state.quietSince >= 10_000) {
            if (this.importedSetupRequired(state, boundImport)) {
              const imported = await this.importedRun(db, true);
              if (!this.importedSetupMatches(state, imported) || imported?.journal.status !== 'activated') {
                throw new BadRequestException('Import activation is not verified');
              }
            }
            state.revision = (await this.checkpoints.getNow()).nowId;
            state.phase = 'complete';
          }
        }
        await this.write(this.key(), state, db);
      }
      return state;
    });
  }

  /**
   * Where an owner's stopped full check got to, for a retry to carry on from. Only a check that stopped (failed or
   * cancelled) part-way through: a finished one has nothing left, and a running one is adopted as it is.
   *
   * The scan walks asset ids in order, so a photo added since the stopped check began with an id below its cursor would
   * be skipped; then the whole check runs again instead.
   */
  private async resumePoint(operationId: string | undefined, db: Kysely<DB>) {
    if (!operationId) return;
    const { rows } = await sql<{
      result: unknown;
      ownerId: string;
      createdAt: Date;
    }>`SELECT result,"ownerId","createdAt"
      FROM media_operation WHERE id=${operationId}::uuid AND status IN ('failed','cancelled')
      AND ${fullScan('media_operation')}`.execute(db);
    const result = rows[0] && parseScanResult(rows[0].result);
    if (!result?.cursor || result.restored) return;
    const { rows: below } = await sql`SELECT 1 FROM asset WHERE "ownerId"=${rows[0].ownerId}::uuid
      AND "createdAt" >= ${rows[0].createdAt} AND id <= ${result.cursor}::uuid LIMIT 1`.execute(db);
    return below.length === 0 ? result : undefined;
  }

  /**
   * The owner would rather let the server run than follow setup (a stopped check, a phone they will not connect).
   * Every held stage is released as if the file check had finished, a pause is lifted, and the setup bar and the
   * phone's preparation step stop asking. Setup keeps tracking in the background; Retry brings it back.
   */
  async dismiss(): Promise<void> {
    this.identity();
    const changed: (MediaOperation | undefined)[] = [];
    await this.locked(async (db) => {
      const state = await this.read<SetupState>(this.key(), db);
      if (!state || state.dismissedAt) return;
      if (state.paused) {
        // A setup whose import no longer matches cannot resume through it (Library Care can); dismissing still ends it.
        await this.applyPause(state, false, changed, db).catch((error) => {
          if (!(error instanceof BadRequestException)) throw error;
        });
      }
      // A run not started yet releases every stage when it starts (startImportedRegeneration); one held because its
      // import is not activated or no longer matches shows as held in Jobs, with Release. The file check itself is not
      // marked finished: the bar would say so if setup were brought back.
      state.dismissedAt = new Date().toISOString();
      await this.applyHolds(state, db, true);
      await this.write(this.key(), state, db);
    });
    for (const row of changed) this.operations.notifyCancellation(row);
  }

  async status(auth?: AuthDto) {
    const identity = this.identity();
    const state = await this.advance();
    const phone = auth?.session ? await this.read<PhoneState>(this.key() + phoneKey(auth.session.id)) : null;
    const operator =
      !auth && state.phase === 'complete'
        ? await sql<{ ready: boolean }>`SELECT EXISTS(SELECT 1 FROM system_metadata
      WHERE key LIKE ${this.key() + ':phone:%'} AND value->>'revision'=${state.revision}
      AND value->>'finished'='true') AS ready`.execute(this.db)
        : null;
    const phoneReady = auth
      ? !!phone && phone.revision === state.revision && phone.finished
      : operator?.rows[0]?.ready === true;
    // A non-admin never receives another user's counts, paths, profile, sync cursor or completion.
    const dismissed = !!state.dismissedAt;
    return {
      setupRequired: !dismissed && (state.phase !== 'complete' || !phoneReady),
      dismissed,
      ...identity,
      phase: state.phase,
      checkProblem: !!state.checkProblem,
      revision: state.revision,
      rescanComplete: state.phase === 'complete',
      verificationPassed: state.phase === 'complete',
      canFinish: dismissed || (state.phase === 'complete' && phoneReady),
      regeneration: !auth || auth.user.isAdmin ? await this.regenerationStatus(state) : null,
      sync: {
        authenticated: !!auth?.session,
        catalogComplete: phone?.revision === state.revision && !!state.revision,
        previewsReady: phone?.finished === true,
      },
    };
  }

  async syncReceipt(auth: AuthDto, revision: string) {
    if (!auth.session) {
      throw new ForbiddenException('A device session is required');
    }
    const state = await this.read<SetupState>(this.key());
    if (!state?.revision || state.phase !== 'complete' || state.revision !== revision) {
      throw new BadRequestException('The library is still preparing');
    }
    const token = randomBytes(32).toString('hex');
    await this.locked(async (db) => {
      const previous = await this.read<PhoneState>(this.key() + phoneKey(auth.session!.id), db);
      await this.write(
        this.key() + phoneKey(auth.session!.id),
        {
          revision,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          finished: previous?.revision === revision && previous.finished,
        } satisfies PhoneState,
        db,
      );
    });
    return token;
  }

  async finish(auth: AuthDto, revision: string, receipt: string, previewsReady: boolean) {
    if (!auth.session) {
      throw new ForbiddenException('A device session is required');
    }
    const status = await this.status(auth);
    await this.locked(async (db) => {
      const phone = await this.read<PhoneState>(this.key() + phoneKey(auth.session!.id), db);
      const ack = (await this.checkpoints.getAll(auth.session!.id)).find(
        (a) => a.type === SyncEntityType.SyncCompleteV1,
      );
      if (
        status.phase !== 'complete' ||
        status.revision !== revision ||
        !phone ||
        phone.revision !== revision ||
        phone.tokenHash !== createHash('sha256').update(receipt).digest('hex') ||
        !previewsReady ||
        !ack ||
        fromAck(ack.ack).updateId < revision
      ) {
        throw new BadRequestException('Finish syncing the current library and browsing previews first');
      }
      await this.write(this.key() + phoneKey(auth.session!.id), { ...phone, finished: true }, db);
    });
    return this.status(auth);
  }
}
