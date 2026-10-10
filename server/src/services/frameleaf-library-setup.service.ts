import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import { AdminConfigDto } from 'src/dtos/config.dto.js';
import { ImmichWorker, JobName, QueueName, SyncEntityType } from 'src/enum.js';
import { IMPORT_DERIVED_RUN_KIND, IMPORT_DERIVED_STAGES, importDerivedRunId } from 'src/immich-import/derived-work.js';
import { listRuns } from 'src/queue/run-query.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { SyncCheckpointRepository } from 'src/repositories/sync-checkpoint.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { LibraryScanService } from 'src/services/library-scan.service.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { SystemConfigService } from 'src/services/system-config.service.js';
import { fromAck } from 'src/utils/sync.js';

type SetupState = {
  installation: string;
  origin: 'new_import' | 'new_library' | 'restored_library';
  phase: 'awaiting-account' | 'rescanning' | 'verifying' | 'needs-attention' | 'complete';
  startedAt: string;
  failedBaseline?: Record<string, number>;
  libraries: string[];
  scans: Record<string, string>;
  revision: string | null;
  quietSince: number | null;
  health: Record<string, string>;
  owners: string[];
  healthAfter: string | null;
  processingChoiceApplied?: boolean;
};
type ImportRunSelection = {
  source: string;
  config: string;
  managerSetup?: { installation: string; operationId: string; preparedAt: string | null; startedAt: string | null };
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
const KEY = 'frameleaf-manager-library-setup';
const phoneKey = (sessionId: string) => `:phone:${sessionId}`;

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
    await this.locked(async (db) => {
      const previous = await this.read<SetupState>(this.key(), db);
      if (previous && previous.phase !== 'awaiting-account' && !(retry && previous.phase === 'needs-attention')) {
        await this.startImportedRegeneration(previous, db);
        return;
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
        config.machineLearning.urls = ['http://immich-machine-learning:3003'];
        await this.config.updateAdminConfigWithRevision({ config, expectedRevision: revision });
        processingChoiceApplied = true;
      }
      const hasAdmin = await this.users.hasAdmin();
      const libraries = hasAdmin ? await this.libraries.getAll() : [];
      const owners = hasAdmin ? await db.selectFrom('asset').select('ownerId').distinct().execute() : [];
      // Commit intent independently of queue submission so a process restart can resume it.
      const state: SetupState = {
        ...identity,
        phase:
          hasAdmin && (identity.origin !== 'new_import' || processingChoiceApplied) ? 'rescanning' : 'awaiting-account',
        startedAt: new Date().toISOString(),
        libraries: libraries.map((l) => l.id),
        scans: {},
        health: {},
        owners: owners.map((owner) => owner.ownerId),
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
  }

  private async importedRun(db = this.db, lock = false) {
    const {
      rows: [journal],
    } = await sql<{ status: string; source_fingerprint: string; config_fingerprint: string }>`
      SELECT status,source_fingerprint,config_fingerprint FROM frameleaf_immich_import`.execute(db);
    if (!journal) return null;
    const id = importDerivedRunId(journal.source_fingerprint, journal.config_fingerprint);
    const {
      rows: [run],
    } = await sql<{ id: string; kind: string; selection: ImportRunSelection; enumerationDone: boolean }>`
      SELECT id,kind,selection,"enumerationDone" FROM job_run WHERE id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}`.execute(
      db,
    );
    return { journal, run };
  }

  /** Restored authority comes only from Manager's private, reviewed canonical recovery metadata. */
  private importInstallation(state: SetupState): string | null {
    if (state.origin === 'new_import') return state.installation;
    const installation = process.env.FRAMELEAF_MANAGER_IMPORT_INSTALLATION;
    return state.origin === 'restored_library' && installation && /^[a-f0-9]{12}$/.test(installation)
      ? installation
      : null;
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
    // Lock the run before selections, matching importer capture and cancellation/release.
    // Capture cannot re-hold snapshots after observing this committed start acknowledgement.
    const imported = await this.importedRun(db, true);
    if (!imported) return;
    const { journal, run } = imported;
    const marker = run?.selection.managerSetup;
    if (
      journal.status !== 'activated' ||
      !run ||
      run.kind !== IMPORT_DERIVED_RUN_KIND ||
      run.selection.source !== journal.source_fingerprint ||
      run.selection.config !== journal.config_fingerprint ||
      marker?.installation !== installation ||
      !marker.operationId ||
      !marker.preparedAt ||
      marker.startedAt ||
      !run.enumerationDone
    )
      return;
    if (state.origin === 'restored_library') {
      const summary = (await listRuns(db, 1, 0, run.id))[0];
      if (!summary || ['completed', 'cancelled', 'completed_with_errors', 'needs_attention'].includes(summary.state)) {
        return;
      }
    }
    const stages = [...IMPORT_DERIVED_STAGES.map(([, stage]) => stage), JobName.PersonGenerateThumbnail];
    const {
      rows: [prepared],
    } = await sql<{ ready: boolean }>`SELECT
      (SELECT count(*) FROM job_selection WHERE "runId"=${run.id}::uuid
        AND stage=ANY(${stages}::text[]) AND "capturedAt" IS NOT NULL)=${stages.length}
      AND NOT EXISTS(SELECT 1 FROM job_selection WHERE "runId"=${run.id}::uuid AND "capturedAt" IS NULL) AS ready`.execute(
      db,
    );
    if (!prepared?.ready) return;
    const startedAt = new Date().toISOString();
    await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,startedAt}',${JSON.stringify(startedAt)}::text::jsonb)
      WHERE id=${run.id}::uuid`.execute(db);
    await sql`UPDATE job_selection SET state='ready' WHERE "runId"=${run.id}::uuid
      AND "capturedAt" IS NOT NULL AND state='enumerating'`.execute(db);
  }

  private async regenerationStatus(state: SetupState) {
    if (state.origin === 'new_library') return null;
    const imported = await this.importedRun();
    const run = imported?.run;
    const marker = run?.selection.managerSetup;
    const installation = this.importInstallation(state);
    // Canonical fresh/independent-copy libraries have no Manager-held import to recover.
    if (state.origin === 'restored_library' && !marker && !installation) return null;
    const matches =
      !!run &&
      run.kind === IMPORT_DERIVED_RUN_KIND &&
      run.selection.source === imported!.journal.source_fingerprint &&
      run.selection.config === imported!.journal.config_fingerprint &&
      !!installation &&
      (marker ? marker.installation === installation : state.origin === 'new_import');
    const summary = matches ? (await listRuns(this.db, 1, 0, run.id))[0] : null;
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

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
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

  private async advance(): Promise<SetupState> {
    await this.begin();
    return this.locked(async (db) => {
      const state = (await this.read<SetupState>(this.key(), db))!;
      if (state.phase === 'rescanning' || state.phase === 'verifying') {
        const admin = await this.users.getAdmin();
        if (!admin) {
          return state;
        }
        for (const libraryId of state.libraries) {
          if (state.scans[libraryId]) {
            continue;
          }
          // Reuse a queued scan whose acknowledgement was lost, including a completed one.
          const existing = await sql<{ id: string }>`SELECT id FROM media_operation WHERE kind='library_scan'
            AND snapshot->>'libraryId'=${libraryId} AND "createdAt" >= ${state.startedAt}::timestamptz
            ORDER BY "createdAt" LIMIT 1`.execute(db);
          const library = await this.libraries.get(libraryId);
          if (!library) {
            throw new BadRequestException('A setup library is unavailable');
          }
          state.scans[libraryId] =
            existing.rows[0]?.id ??
            (await this.scans.queue(library, { ownerId: admin.id, trigger: 'manual' })).operation.id;
        }
        const ids = Object.values(state.scans);
        const records =
          ids.length > 0
            ? await sql<{
                id: string;
                status: string;
              }>`SELECT id,status FROM media_operation WHERE id=ANY(${ids}::uuid[])`.execute(db)
            : { rows: [] };
        const scansFinished = state.libraries.every((id) =>
          records.rows.some((r) => r.id === state.scans[id] && r.status === 'completed'),
        );
        if (records.rows.some((record) => ['failed', 'cancelled'].includes(record.status))) {
          state.phase = 'needs-attention';
        }
        if (scansFinished && !state.healthAfter) {
          // Commit full-scan admission after external discovery. The following call can safely
          // recover a lost queue acknowledgement, and must cover the resulting inventory.
          state.healthAfter = new Date().toISOString();
          state.owners = (await db.selectFrom('asset').select('ownerId').distinct().execute()).map(
            (owner) => owner.ownerId,
          );
          await this.write(this.key(), state, db);
          return state;
        }
        // Library Care's durable full scan covers managed uploads as well as external files,
        // including original-file integrity. Reuse its operation after a lost acknowledgement.
        if (scansFinished) {
          for (const ownerId of state.owners) {
            if (state.health[ownerId]) {
              continue;
            }
            const existing = await sql<{ id: string }>`SELECT id FROM media_operation WHERE kind='media_health'
            AND "ownerId"=${ownerId}::uuid AND snapshot->>'mode'='scan' AND NOT (snapshot ? 'changedSince')
            AND "createdAt" >= ${state.healthAfter}::timestamptz ORDER BY "createdAt" LIMIT 1`.execute(db);
            const operationId =
              existing.rows[0]?.id ??
              (await this.mediaHealth.startMissingScan({ user: { id: ownerId } } as AuthDto)).operationId;
            if (!operationId) {
              throw new BadRequestException('Library integrity scan could not be queued');
            }
            const eligible = await sql<{ id: string }>`SELECT id FROM media_operation WHERE id=${operationId}::uuid
              AND kind='media_health' AND "ownerId"=${ownerId}::uuid AND snapshot->>'mode'='scan'
              AND NOT (snapshot ? 'changedSince') AND "createdAt" >= ${state.healthAfter}::timestamptz`.execute(db);
            if (eligible.rows.length === 0) {
              continue; // Wait for an incompatible active scan before admitting ours.
            }
            state.health[ownerId] = operationId;
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
          WHERE op.id=ANY(${healthIds}::uuid[]) AND op.kind='media_health' AND op.snapshot->>'mode'='scan'
            AND NOT (op.snapshot ? 'changedSince') AND op."createdAt" >= ${state.healthAfter}::timestamptz`.execute(db)
            : { rows: [] };
        if (health.rows.some((record) => ['failed', 'cancelled'].includes(record.status) || record.problems)) {
          state.phase = 'needs-attention';
        }
        const healthFinished = state.owners.every((id) =>
          health.rows.some(
            (record) =>
              record.id === state.health[id] && record.status === 'completed' && record.verified && !record.problems,
          ),
        );
        // Sidecar completion enqueues metadata, which enqueues derivatives. An idle downstream
        // queue alone cannot establish a final sync revision.
        const queues = await Promise.all(SETUP_QUEUES.map((q) => this.jobs.getJobCounts(q)));
        if (queues.some((q, i) => q.failed > (state.failedBaseline?.[SETUP_QUEUES[i]] ?? 0))) {
          state.phase = 'needs-attention';
        }
        const idle = queues.every((q) => q.active === 0 && q.waiting === 0 && q.delayed === 0 && q.paused === 0);
        if (!scansFinished || !healthFinished || !idle || state.phase === 'needs-attention') {
          state.quietSince = null;
        } else {
          state.phase = 'verifying';
          state.quietSince ??= Date.now();
          if (Date.now() - state.quietSince >= 10_000) {
            if (state.origin === 'new_import') {
              const audit = await sql<{ ok: boolean }>`SELECT EXISTS(SELECT 1 FROM public.frameleaf_immich_import
                WHERE status='activated') AS ok`.execute(db);
              if (!audit.rows[0]?.ok) {
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
    return {
      setupRequired: state.phase !== 'complete' || !phoneReady,
      ...identity,
      phase: state.phase,
      revision: state.revision,
      rescanComplete: state.phase === 'complete',
      verificationPassed: state.phase === 'complete',
      canFinish: state.phase === 'complete' && phoneReady,
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
