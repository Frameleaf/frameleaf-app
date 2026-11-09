import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, stat, statfs, rename, open, realpath, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { Store } from './store.js';
import { Docker, type ImportInspection } from './docker.js';
import { Discovery, COMPATIBLE_SETTINGS, maskSettings, unmaskSettings, unsupportedSettings } from './discovery.js';
import { Releases, type VerifiedRelease } from './releases.js';
import { compareReleases, isNewerRelease } from './release-order.js';
import { Backups, sourceBackups } from './backups.js';
import { assertExternalFolder, assertSeparateFolders, broadRoots, ensureChosenFolder, inside, overlaps } from './folders.js';
import { Fencing } from './fencing.js';
import { detectPhotoApps, identifyPhotoApp, photoAppKind, photoAppNames, type ContainerFileReader, type PhotoAppKind, type PhotoAppPlan } from './photo-app-sources.js';
import { capturePhotoAppSource, restoreDatabaseUrl, type PhotoAppCapture } from './photo-app-capture.js';
import { captureEnteFolder, folderImportNames, folderSourceId, importFolderPath, readEnteExport, type FolderImportKind } from './photo-app-folder.js';
import { IMPORT_PREPARATION_TARGET, commonImportBootstrapStaged, prepareCommonImportRuntime, removeCommonImportBootstrap, stageCommonImportBootstrap, stageCommonImportPreparation } from './common-import-runtime.js';
import { rollbackCommonImport } from './common-import-lifecycle.js';
import type { ImportPreparationSeal, ImportSourceAuthoritySeal } from './import-source-authority.js';
import type { AutostartFile } from './unraid-autostart.js';
import { containerNumber } from './dockerman.js';
import { ApplicationConfig, checkServiceOverrides, detectAcceleration, releaseImages, renderCompose, retuneDatabase, ServiceOverrides, STUDIO_WORKER_TARGET, storagePath } from './compose.js';
import { atomicJson, copyVerified, fileHash } from './files.js';
import { PostgresStorage } from './postgres-storage.js';
import { toContainer, toHost } from './host-paths.js';
import { hostRealpaths, type HostRealpaths } from './host-realpath.js';
import { LibraryMove, type ServerPauseStatus } from './library-move.js';
import { Retention } from './retention.js';
import { ServerCheck, checkHost, freeBytes, type CheckFacts, type CheckOutcome } from './server-check.js';
import { DOWNLOAD_HOSTS, LOW_MEMORY, downloadUrl, dockerRoomNeeded, hostProbes, type HostProbes } from './host-probes.js';
import { assertMountSources, folderExists, libraryMounts, seedThumbnailMarker, thumbnailFolder, thumbnailMount, withThumbnails } from './mounts.js';
import { environment } from './docker.js';
import { elapsed, log } from './banner.js';
import {
  Refusal,
  containerId,
  databaseImageChangeAllowed,
  databaseImageMove,
  digest,
  postgresMajor,
  postgresVersion,
  recentBackup,
  releaseTag,
  type Installation,
  type Mount,
  type Source,
  type SourceFence,
  type Operation,
  type Database,
  type Backup,
  publicSource,
  redact,
} from './contracts.js';

const importNames: Record<PhotoAppKind | FolderImportKind, string> = { ...photoAppNames, ...folderImportNames };
export const ReviewInput = z
  .object({
    kind: z.enum(['install', 'import']),
    name: z.string().trim().min(1).max(120).optional(),
    tag: releaseTag,
    sourceId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    mediaPath: z.string().min(1).max(4096).optional(),
    /** Only where folders are chosen in Manager (a new Unraid install). */
    backupPath: z.string().min(1).max(4096).optional(),
    databaseRoot: z.string().min(1).max(4096),
    port: z.number().int().min(1024).max(65535),
    ml: z.boolean(),
    lifecycle: z.literal('docker-only'),
    /** Advanced container settings; applied to the generated stack and kept across updates. */
    services: ServiceOverrides.optional(),
  })
  .strict();
/** POST photo-app-prepare: every inspected owner gets an email, every reported loss is approved. */
export const PhotoAppPrepareInput = z.strictObject({
  operationId: z.uuid(),
  owners: z
    .array(
      z.strictObject({
        sourceId: z.string().min(1).max(1024),
        email: z.email().max(254),
        acknowledgeRestrictions: z.boolean().optional(),
      }),
    )
    .max(10_000),
  approvedLossCodes: z.array(z.string().min(1).max(1024)).max(1000),
  review: ReviewInput.pick({ tag: true, backupPath: true, databaseRoot: true, port: true, ml: true, name: true, services: true })
    .extend({ mediaPath: z.string().min(1).max(4096) })
    .strict(),
});
export type CommonImportReview = {
  fence: SourceFence;
  destinationId: string;
  bundleName?: string;
  bootstrapAdminId?: string;
  requiredMediaBytes: number;
  summary: { owners: number; assets: number; files: number; albums: number; preservationDifferences: number };
  binding: ImportSourceAuthoritySeal['binding'];
  media: { source: string; target: string; readOnly: boolean }[];
};
function assertCommonImportReview(operation: Operation, common?: CommonImportReview) {
  const expected = operation.receipts['reviewed-common-import'];
  if (common ? common.binding.operationId !== operation.id || digest(common) !== expected : expected !== undefined)
    throw new Refusal('invalid_import_authority');
}
type Review = {
  id: string;
  approvalToken?: string;
  expires: number;
  /** The port the administrator reached Manager on, so the stack cannot be offered Manager's own port. */
  managerPort?: number;
  input: z.infer<typeof ReviewInput>;
  release: VerifiedRelease;
  source: Source | null;
  common?: CommonImportReview;
  backup: Backup | null;
  platform: string;
};
const Recovery = z
  .object({
    schemaVersion: z.literal(2),
    mediaIncluded: z.literal(false),
    databaseFormat: z.enum(['frameleaf-canonical', 'immich-source']),
    databasePassword: z.string().min(32).max(256),
    application: ApplicationConfig,
    dumpSha256: z.string().regex(/^[a-f0-9]{64}$/),
    installation: z
      .object({
        id: z.string().regex(/^[a-f0-9]{12}$/),
        name: z.string().trim().min(1).max(120).optional(),
        project: z.string().regex(/^frameleaf-[a-f0-9]{12}$/),
        release: releaseTag,
        port: z.number().int().min(1024).max(65535),
        ml: z.boolean(),
        origin: z.enum(['new_library', 'new_import', 'restored_library']),
        importInstallation: z
          .string()
          .regex(/^[a-f0-9]{12}$/)
          .optional(),
        libraryId: z
          .string()
          .regex(/^[a-f0-9]{12}$/)
          .optional(),
        sourceId: z.string().nullable(),
        mayHaveWrittenMedia: z.boolean(),
        databaseRoot: z.string().min(1).max(4096),
        databasePath: z.string().min(1).max(4096),
        mounts: z
          .array(
            z
              .object({
                type: z.enum(['bind', 'volume']),
                source: z.string().min(1).max(4096),
                target: z.string().regex(/^\/(?!$)[^\n\0]+$/),
                readOnly: z.boolean(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
  })
  .strict();
type RestoreReview = {
  id: string;
  expires: number;
  snapshot: string;
  checkpoint: string;
  hash: string;
  databaseRoot: string;
  databaseBytes: number;
  release: VerifiedRelease;
  recovery: z.infer<typeof Recovery>;
  platform: string;
  current: Installation | null;
  /**
   * FL-1320: the mounts the restored library gets: the backup's library mounts with thumbnails where they are
   * now (the current installation's folder, else the backup's). Absent in reviews saved before FL-1320.
   */
  mounts?: Mount[];
  /** The thumbnail folder was gone and the administrator chose the library's own `thumbs` folder instead. */
  thumbnailFallback?: { missing: string; folder: string };
};
type UpdateReview = {
  expires: number;
  current: Installation;
  release: VerifiedRelease;
  platform: string;
  /** FL-1265: the update moves the database to a new image by dump and restore. */
  databaseMove?: { from: string; to: string; bytes: number };
};
/** Row counts of every table, the extensions and the server version, compared across a database move. */
type DatabaseInventory = { version: string; extensions: string[]; tables: Record<string, number> };
/** Journaled before a database move changes anything; `attempts` are the new folders allocated so far. */
type DatabaseMoveIntent = {
  from: { image: string; databasePath: string };
  to: { image: string };
  source: DatabaseInventory;
  /** Room each attempt's folder needs: the source database's size, the estimate the review checked. */
  bytes: number;
  attempts: string[];
};
type DatabaseMove = Omit<DatabaseMoveIntent, 'to'> & { to: { image: string; databaseRoot?: string; databasePath: string } };
/** Where moveDatabase restores to: an update keeps the folder it is in, a drive move (FL-1322) names another. */
type DatabaseMoveTarget = { current: Installation; release: VerifiedRelease; databaseRoot: string };
/** FL-1322: a reviewed move of the database to another folder or drive, on the same release and image. */
type DatabaseRelocationReview = {
  id: string;
  expires: number;
  current: Installation;
  release: VerifiedRelease;
  databaseRoot: string;
  /** The measured database size: the copy's room, and again for a later engine upgrade's second copy. */
  bytes: number;
};
const DATABASE_INVENTORY = `SELECT json_build_object(
  'version', split_part(current_setting('server_version'), ' ', 1),
  'extensions', (SELECT coalesce(json_agg(extname ORDER BY extname), '[]') FROM pg_extension),
  'tables', (SELECT coalesce(json_object_agg(format('%I.%I', table_schema, table_name),
      (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint), '{}')
    FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')));`;
const sameInventory = (a: DatabaseInventory, b: DatabaseInventory) =>
  digest([...a.extensions].sort()) === digest([...b.extensions].sort()) &&
  digest(Object.entries(a.tables).sort(([x], [y]) => (x < y ? -1 : 1))) ===
    digest(Object.entries(b.tables).sort(([x], [y]) => (x < y ? -1 : 1)));
/**
 * Whether an update may have started its target release: apply-release completed, or it journaled
 * `release-start-state = 'starting'` right before `compose up`. An update that failed inside apply-release
 * before that point (eligibility, fencing or database-image checks) never ran the target and stays
 * cancellable even when its selected release was withdrawn and cannot be retargeted (review: operations.ts).
 */
const updateStarted = (operation: Pick<Operation, 'completed' | 'receipts'>): boolean =>
  operation.completed.includes('apply-release') ||
  ['starting', 'started'].includes(operation.receipts['release-start-state'] as string);
type Cancellation = {
  kind: 'backup' | 'update' | 'source' | 'restore' | 'reconfigure' | 'move-database';
  installation: Installation | null;
  archive: string;
};
type PreviousInstallation = {
  installation: Installation;
  password: string;
  application: ApplicationConfig;
  onboardingFinished: unknown;
  archive: string;
};
export class Operations {
  private mediaMove: LibraryMove;
  /** FL-1322: host paths resolved as the host sees them, before a retained database folder is removed. */
  hostRealpaths: HostRealpaths;
  private discovery: Discovery;
  private fencing: Fencing;
  private retention: Retention;
  private executing = new Set<string>();
  /** How often an update's start polls Docker for the new server's health. Docker keeps its last five probes. */
  serverWatchMs = 5000;
  /** FL-1318: what Check this server asks the host itself (Docker storage, downloads, host ports, Unraid's Docker tab). */
  probes: HostProbes;
  constructor(
    readonly store: Store,
    readonly docker: Docker,
    readonly releases: Releases,
    readonly backups: Backups,
    private roots: string[],
    private databaseStorage: PostgresStorage,
    private autostartFile?: string | AutostartFile,
  ) {
    this.discovery = new Discovery(docker);
    this.hostRealpaths = hostRealpaths(docker, store.directory);
    this.probes = hostProbes(docker, store.directory);
    this.fencing = new Fencing(docker, store, autostartFile);
    this.retention = new Retention(store, store.directory, join(store.directory, 'releases'));
    this.mediaMove = new LibraryMove(
      store,
      docker,
      this.fencing,
      new PostgresStorage(docker, store.directory, roots, !!databaseStorage?.unraid),
      store.directory,
      process.env.MANAGER_BACKUP_ROOT ?? join(store.directory, 'backups'),
      undefined,
      {
        pause: (operationId) => this.libraryMovePause('POST', '/pause', { operationId }),
        status: (operationId) =>
          this.libraryMovePause('GET', operationId ? `?operationId=${encodeURIComponent(operationId)}` : ''),
        resume: (operationId) => this.libraryMovePause('POST', '/resume', { operationId }),
      },
    );
  }
  /** FL-360: the server's machine-authenticated library move pause, called from inside its container. */
  private async libraryMovePause(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ServerPauseStatus> {
    return this.serverRequest(method, `library-move/manager${path}`, body) as Promise<ServerPauseStatus>;
  }
  /**
   * Call a machine-authenticated `/api/server/...` endpoint from inside the server container, with the
   * mounted Manager token. A refusal surfaces as `server_refused_<status>`; the token is never echoed.
   */
  private async serverRequest(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const installation = this.installation();
    if (!installation) throw new Refusal('no_installation');
    const server = (await this.docker.inventory()).find(
      (c) =>
        c.Config.Labels?.['app.frameleaf.manager'] === installation.id &&
        !c.Config.Labels?.['app.frameleaf.manager.import'] &&
        c.Config.Labels?.['com.docker.compose.service'] === 'frameleaf-server',
    );
    if (!server?.State.Running) throw new Refusal('application_unavailable');
    const script = `const fs=require('node:fs'),b=process.argv[3];fetch('http://127.0.0.1:2283/api/server/'+process.argv[2],{method:process.argv[1],headers:{'x-frameleaf-manager':fs.readFileSync('/run/frameleaf/manager-token','utf8').trim(),...(b?{'content-type':'application/json'}:{})},body:b||undefined}).then(async r=>process.stdout.write(JSON.stringify(r.ok?{value:await r.json()}:{status:r.status}))).catch(()=>process.exit(1));`;
    const result = JSON.parse(
      await this.docker.node(server.Id, script, [method, path, body ? JSON.stringify(body) : '']),
    ) as { value?: unknown; status?: number };
    if (result.status !== undefined) throw new Refusal(`server_refused_${Number(result.status)}`, 502);
    return result.value;
  }
  reviewMove(root: string) {
    return this.mediaMove.review(root);
  }
  move(id: string, key: string): Operation {
    const { operation, created } = this.mediaMove.start(id, key);
    if (created) this.launch(operation, () => this.applyMove(operation));
    return operation;
  }
  async stopMove(id: string): Promise<void> {
    const operation = this.store.history().find((o) => o.id === id);
    if (!operation || operation.kind !== 'move-library' || operation.state === 'complete')
      throw new Refusal('operation_not_recoverable');
    await this.mediaMove.stop(operation);
  }
  private applyMove(operation: Operation): Promise<void> {
    return this.mediaMove.run(
      operation,
      (name, action) => this.step(operation, name, action),
      async () => {
        await this.backups.initialize();
        return this.backups.snapshot(await this.checkpoint(operation), operation.id);
      },
      () => this.libraryStatus(),
    );
  }
  installation(): Installation | null {
    return this.store.get('installation');
  }
  /** Removes dumps, recovery records, restore reviews and old release bundles no open operation needs. */
  prune(): Promise<string[]> {
    return this.retention.sweep();
  }
  /** A new installation id whose container number no other installation on this host uses. */
  private async newInstallationId(): Promise<string> {
    // Best effort: the check before `up` catches any clash this misses, so a failed listing must not stop the operation.
    const containers = await this.docker.inventory().catch(() => []);
    const used = new Set(containers.map((c) => containerNumber(c.Config.Labels?.['app.frameleaf.manager'] ?? '')));
    for (;;) {
      const id = randomBytes(6).toString('hex');
      if (!used.has(containerNumber(id))) return id;
    }
  }
  directory(): string {
    return join(this.store.directory, 'stack');
  }
  private application(): ApplicationConfig {
    return ApplicationConfig.parse(this.store.get('application-config') ?? { environment: {}, settings: null });
  }
  async discover() {
    const found = await this.discovery.list();
    for (const source of found.sources) this.store.set(`source:${source.id}`, source);
    return { ...found, sources: found.sources.map((source) => this.editedSource(source)) };
  }
  /** Applies the administrator's settings edit while the source settings it was made against are unchanged. */
  private editedSource(source: Source): Source {
    const edit = this.store.get<{ base: string; settings: Record<string, unknown> }>(`source-settings:${source.id}`);
    if (!edit || edit.base !== digest(source.settings ?? {})) return source;
    return {
      ...source,
      settings: edit.settings,
      unsupportedSettings: unsupportedSettings(edit.settings),
      settingsBase: edit.base,
    };
  }
  sourceSettings(id: string) {
    const source = this.store.get<Source>(`source:${id}`);
    if (!source) throw new Refusal('select_source_installation');
    const edited = this.editedSource(source);
    return {
      settings: maskSettings(edited.settings ?? {}),
      supported: COMPATIBLE_SETTINGS,
      source: publicSource(edited),
    };
  }
  /** `null` discards the edit and returns to the source installation's own settings. */
  async saveSourceSettings(id: string, settings: Record<string, unknown> | null) {
    if (this.installation()) throw new Refusal('installation_already_exists');
    const source = this.store.get<Source>(`source:${id}`);
    if (!source) throw new Refusal('select_source_installation');
    await this.discovery.revalidate(source);
    if (settings === null) this.store.set(`source-settings:${id}`, null);
    else
      this.store.set(`source-settings:${id}`, {
        base: digest(source.settings ?? {}),
        settings: unmaskSettings(settings, source.settings ?? {}) as Record<string, unknown>,
      });
    return this.sourceSettings(id);
  }
  private async serverStarted(installation: Installation): Promise<boolean> {
    return (await this.docker.inventory()).some(
      (c) =>
        c.Config.Labels?.['app.frameleaf.manager'] === installation.id &&
        !c.Config.Labels?.['app.frameleaf.manager.import'] &&
        c.Config.Labels?.['com.docker.compose.service'] === 'frameleaf-server' &&
        (c.State.Running || !(c.State.StartedAt ?? '').startsWith('0001-')),
    );
  }
  async librarySummary() {
    const database = await this.targetDatabase();
    // Before the server's first start has run migrations there is no library to count.
    if ((await this.docker.sql(database, `SELECT to_regclass('public.asset') IS NOT NULL;`)).trim() !== 't') return null;
    return JSON.parse(
      await this.docker.sql(
        database,
        `SELECT json_build_object('assets',(SELECT count(*) FROM public.asset),'users',(SELECT count(*) FROM public.user),'albums',(SELECT count(*) FROM public.album));`,
      ),
    );
  }
  private async reviewedSource(id: string, requireCompatible = true) {
    const stored = this.store.get<Source>(`source:${id}`);
    if (!stored) throw new Refusal('select_source_installation');
    await this.discovery.revalidate(stored);
    const source = this.editedSource(stored);
    // Review still opens so the administrator can see and edit the settings; cutover cannot start.
    if (requireCompatible && source.unsupportedSettings.length) throw new Refusal('incompatible_settings_require_review');
    if (source.platform === 'unraid') {
      if (!this.autostartFile) throw new Refusal('unraid_autostart_file_required');
      await this.fencing.readAutostart(true);
    }
    return { source, backup: recentBackup(await sourceBackups(this.docker, source), source) ?? null };
  }
  async sourceReview(id: string) {
    if (this.installation()) throw new Refusal('installation_already_exists');
    const { source, backup } = await this.reviewedSource(id, false);
    return {
      source: publicSource(source),
      backup: backup ? { action: 'reuse', name: backup.name, takenAt: backup.takenAt } : { action: 'create' },
    };
  }
  /**
   * Small text files of a photo app's configuration (Nextcloud config.php, Piwigo database.inc.php, PiGallery2
   * config.json): through the running container, else through the host folder it maps.
   */
  private readAppFile: ContainerFileReader = async (container, path) => {
    const limit = 1_048_576;
    if (container.State.Running) {
      try {
        const text = await this.docker.readFile(container.Id, path);
        return text.length <= limit ? text : null;
      } catch {
        /* fall back to the host mount */
      }
    }
    const mount = container.Mounts.filter(
      (m) => m.Source && (m.Destination === path || path.startsWith(`${m.Destination.replace(/\/$/u, '')}/`)),
    ).sort((a, b) => b.Destination.length - a.Destination.length)[0];
    if (!mount) return null;
    try {
      const host = mount.Source + path.slice(mount.Destination.length);
      const info = await stat(host);
      return info.isFile() && info.size <= limit ? await readFile(host, 'utf8') : null;
    } catch {
      return null;
    }
  };
  /** How long a restored copy of a source database may take to accept connections (polls once per delay). */
  restoreReadyDelayMs = 1000;
  /** FL-1149 (Beta): photo apps on this host, importable or with the reason code they are not. */
  async photoAppSources() {
    return { sources: await detectPhotoApps(await this.docker.inventory(), this.readAppFile) };
  }
  /** Reserve the shared operation before any source service can be stopped. */
  async startCommonCapture(sourceContainer: string, key: string) {
    if (!containerId.safeParse(sourceContainer).success || this.installation()) throw new Refusal('invalid_import_authority');
    const all = await this.docker.inventory();
    const app = all.find((c) => c.Id === sourceContainer);
    const kind = app && photoAppKind(app);
    if (!app || !kind) throw new Refusal('photo_app_not_recognised');
    const input = { sourceId: digest([kind, app.Id]), commonCapture: sourceContainer, photoApp: kind };
    // A retried request returns its operation even after its app was stopped.
    const prior = this.store.request('import', key, input);
    if (prior) return prior;
    let plan: PhotoAppPlan;
    try {
      plan = await identifyPhotoApp(app, all, this.readAppFile);
    } catch (error) {
      if (error instanceof Refusal) throw new Refusal('photo_app_not_importable', 409, error.code);
      throw error;
    }
    if (plan.fence.id !== input.sourceId) throw new Refusal('invalid_import_authority');
    const { operation, created } = this.store.start('import', key, input);
    if (created) {
      // The plan holds the source database login: private store only, never the journal or a response.
      this.store.set(`photo-app-plan:${operation.id}`, plan);
      operation.receipts['common-source-fence'] = plan.fence;
      this.store.save(operation);
      this.launch(operation, () => this.captureForReview(operation));
    }
    return operation;
  }
  /**
   * FL-1149 (Beta): an export folder the owner made with the app's own tool (Ente Photos). Nothing is stopped; the
   * folder must sit inside Manager's storage roots and hold the export and its saved file list.
   */
  async startFolderImport(kind: FolderImportKind, path: string, key: string) {
    if (kind !== 'ente' || this.installation()) throw new Refusal('invalid_import_authority');
    const folder = await importFolderPath(path, this.roots);
    const input = { sourceId: folderSourceId(kind, folder), commonCapture: 'folder', photoApp: kind, importFolder: folder };
    const prior = this.store.request('import', key, input);
    if (prior) return prior;
    await readEnteExport(folder);
    const { operation, created } = this.store.start('import', key, input);
    if (created) this.launch(operation, () => this.captureForReview(operation));
    return operation;
  }
  private async captureForReview(operation: Operation) {
    if (operation.input.commonCapture === 'folder') await this.captureFolderSource(operation);
    else await this.captureCommonSource(operation);
    operation.state = 'awaiting-review';
  }
  /** Reads the export folder's identity and revision; the review and preparation mount it read-only. */
  private async captureFolderSource(operation: Operation): Promise<PhotoAppCapture> {
    const folder = operation.input.importFolder;
    if (
      typeof folder !== 'string' || operation.input.photoApp !== 'ente' || operation.kind !== 'import' ||
      operation.state !== 'running' || operation.input.sourceId !== folderSourceId('ente', folder) || this.installation()
    ) throw new Refusal('invalid_import_authority');
    const capture = await this.step(operation, 'capture-common-source', async () => {
      await mkdir(join(this.directory(), `import-runtime-${operation.id}`), { mode: 0o700, recursive: true });
      return captureEnteFolder(await importFolderPath(folder, this.roots));
    });
    await this.fencing.verify(capture.fence);
    return capture;
  }
  /** Capture only for a locked operation with an explicitly selected source. */
  async captureCommonSource(operation: Operation): Promise<PhotoAppCapture> {
    const plan = this.store.get<PhotoAppPlan>(`photo-app-plan:${operation.id}`);
    const recorded = operation.receipts['common-source-fence'] as SourceFence | undefined;
    if (
      !plan || !recorded || digest(recorded) !== digest(plan.fence) ||
      operation.kind !== 'import' || operation.state !== 'running' ||
      operation.input.sourceId !== plan.fence.id || operation.input.commonCapture !== plan.container ||
      this.installation() || !z.uuid().safeParse(operation.id).success
    ) throw new Refusal('invalid_import_authority');
    const capture = await this.step(operation, 'capture-common-source', async () => {
      await mkdir(this.directory(), { mode: 0o700, recursive: true });
      const stagingRoot = join(this.directory(), `import-runtime-${operation.id}`);
      await mkdir(stagingRoot, { mode: 0o700, recursive: true });
      return capturePhotoAppSource(this.fencing, this.docker, plan, {
        operationId: operation.id,
        stagingRoot,
        restoreSecrets: plan.server ? this.restoreSecrets(operation.id) : undefined,
        beforeRestore: (name) => {
          operation.receipts['photo-app-restore'] = name;
          this.store.save(operation);
        },
        readyDelayMs: this.restoreReadyDelayMs,
      });
    });
    await this.fencing.verify(capture.fence);
    return capture;
  }
  /** The disposable copy's root and reader passwords, created once per operation in the private store. */
  private restoreSecrets(operationId: string): { root: string; reader: string } {
    const key = `photo-app-restore:${operationId}`;
    const existing = this.store.get<{ root: string; reader: string }>(key);
    if (existing) return existing;
    const secrets = { root: randomBytes(32).toString('hex'), reader: randomBytes(32).toString('hex') };
    this.store.set(key, secrets);
    return secrets;
  }
  /** A captured photo-app import waiting for its review, not running anything. */
  private capturedPhotoApp(operationId: string): Operation {
    const operation = this.store.history().find((o) => o.id === operationId);
    if (
      !operation || operation.kind !== 'import' || typeof operation.input.commonCapture !== 'string' ||
      operation.state !== 'awaiting-review' || this.executing.has(operationId) ||
      operation.receipts['reviewed-common-import'] !== undefined || !operation.receipts['capture-common-source']
    ) throw new Refusal('photo_app_capture_not_ready');
    return operation;
  }
  private photoAppIdentity(operation: Operation): { destinationId: string; owners: Record<string, string>; bootstrapAdminId: string } {
    const ids = (operation.receipts['photo-app-ids'] as { destinationId: string; owners: Record<string, string>; bootstrapAdminId?: string } | undefined) ??
      { destinationId: randomUUID(), owners: {} };
    // Owner decision 2026-10-30: the first administrator is always a local account the installer creates.
    ids.bootstrapAdminId ??= randomUUID();
    operation.receipts['photo-app-ids'] = ids;
    return ids as { destinationId: string; owners: Record<string, string>; bootstrapAdminId: string };
  }
  /** The v2 `prepare-library-import` request for this captured source. */
  private photoAppRequest(
    operation: Operation,
    capture: PhotoAppCapture,
    action: 'inspect' | 'prepare',
    owners: { sourceId: string; destinationId: string; email: string; acknowledgeRestrictions?: boolean }[],
    approvedLossCodes: string[],
  ) {
    const stagingRoot = join(this.directory(), `import-runtime-${operation.id}`);
    let location: { snapshotPath: string } | { databaseUrl: string } | Record<string, never>;
    if (capture.database === 'export' && capture.fence.folder && !capture.snapshotPath && !capture.restore) location = {};
    else if (capture.snapshotPath) {
      const path = relative(stagingRoot, capture.snapshotPath);
      if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Refusal('invalid_import_authority');
      location = { snapshotPath: `${IMPORT_PREPARATION_TARGET}/${path}` };
    } else if (capture.restore) {
      const secrets = this.store.get<{ reader: string }>(`photo-app-restore:${operation.id}`);
      if (!secrets?.reader) throw new Refusal('invalid_import_authority');
      location = { databaseUrl: restoreDatabaseUrl(capture.restore, secrets.reader) };
    } else throw new Refusal('invalid_import_authority');
    return {
      format: 'frameleaf-prepare-library-import',
      version: 2,
      action,
      operationId: operation.id,
      destinationId: this.photoAppIdentity(operation).destinationId,
      source: capture.source,
      ...location,
      originalsRoot: '/import-media/source',
      ...(capture.sourceRootPath && { sourceRootPath: capture.sourceRootPath }),
      approvedLossCodes,
      owners,
    };
  }
  /** The server image of a release this host can run, downloaded for the offline preparation. */
  private async preparationImage(tag: string | undefined): Promise<string> {
    const chosen = tag ?? (await this.releases.available())[0]?.tag;
    if (!chosen) throw new Refusal('release_unavailable');
    const platform = (await this.docker.compatibility()).platform;
    const release = await this.releases.acquire(chosen);
    if (!release.nas.platforms.includes(platform)) throw new Refusal('release_architecture_unavailable');
    await this.docker.pull(release.nas.images.server, platform);
    return release.nas.images.server;
  }
  /** Review-only pass over the frozen source: owners, counts and losses. Run once; the answer is journaled. */
  async inspectPhotoApp(operationId: string, tag?: string): Promise<ImportInspection> {
    const operation = this.capturedPhotoApp(operationId);
    const cached = operation.receipts['photo-app-inspection'] as ImportInspection | undefined;
    if (cached) return cached;
    this.executing.add(operationId);
    try {
      const capture = operation.receipts['capture-common-source'] as PhotoAppCapture;
      const request = this.photoAppRequest(operation, capture, 'inspect', [], []);
      this.store.save(operation);
      const image = await this.preparationImage(tag);
      await this.fencing.verify(capture.fence);
      const path = await stageCommonImportPreparation(this.directory(), operationId, request);
      const preparationSha256 = await fileHash(path);
      const inspection = await this.docker.inspectImportSource(
        this.directory(),
        image,
        {
          operationId,
          destinationId: request.destinationId,
          source: capture.source,
          preparationSha256,
          verify: async () => {
            await this.fencing.verify(capture.fence);
            if ((await fileHash(path)) !== preparationSha256) throw new Refusal('import_common_review_changed');
          },
        },
        [{ source: capture.originalsPath, target: '/import-media/source' }],
        capture.restore?.name,
      );
      operation.receipts['photo-app-inspection'] = inspection;
      this.store.save(operation);
      return inspection;
    } finally {
      this.executing.delete(operationId);
    }
  }
  /**
   * Map every inspected owner to an email, approve every reported loss, then prepare the bundle and return the
   * ordinary common-import review (install with its approval token).
   */
  async preparePhotoApp(value: z.infer<typeof PhotoAppPrepareInput>, managerPort?: number) {
    const operation = this.capturedPhotoApp(value.operationId);
    const inspection = operation.receipts['photo-app-inspection'] as ImportInspection | undefined;
    if (!inspection) throw new Refusal('photo_app_inspection_required');
    const expected = inspection.owners.map((owner) => owner.sourceId);
    const chosen = value.owners.map((owner) => owner.sourceId);
    if (new Set(chosen).size !== chosen.length || chosen.length !== expected.length || expected.some((id) => !chosen.includes(id)))
      throw new Refusal('photo_app_owner_unmapped');
    const emails = value.owners.map((owner) => owner.email.toLowerCase());
    if (new Set(emails).size !== emails.length) throw new Refusal('photo_app_owner_email_duplicate');
    const losses = inspection.losses.map((loss) => loss.code);
    const approved = new Set(value.approvedLossCodes);
    if (losses.some((code) => !approved.has(code)) || [...approved].some((code) => !losses.includes(code)))
      throw new Refusal('photo_app_loss_unapproved');
    const capture = operation.receipts['capture-common-source'] as PhotoAppCapture;
    const ids = this.photoAppIdentity(operation);
    for (const id of expected) ids.owners[id] ??= randomUUID();
    const request = this.photoAppRequest(
      operation,
      capture,
      'prepare',
      value.owners.map(({ sourceId, email, acknowledgeRestrictions }) => ({
        sourceId,
        destinationId: ids.owners[sourceId],
        email,
        ...(acknowledgeRestrictions !== undefined && { acknowledgeRestrictions }),
      })),
      losses,
    );
    this.store.save(operation);
    const input = ReviewInput.parse({ ...value.review, kind: 'import', sourceId: capture.fence.id, lifecycle: 'docker-only' });
    // Placements are library/<owner>/…; the preparation reviews them with /data read-only, so the owner folders
    // must exist first. Only these folders, private, in an approved and writable destination.
    if (broadRoots(this.roots)) await ensureChosenFolder(input.mediaPath!);
    const media = await storagePath(input.mediaPath!, this.roots, 0);
    for (const folder of [join(media, 'library'), ...expected.map((id) => join(media, 'library', ids.owners[id]))]) {
      await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      if (!(await lstat(folder)).isDirectory() || (await realpath(folder)) !== folder) throw new Refusal('import_runtime_media_invalid');
    }
    return this.prepareCommonReview(
      input,
      {
        fence: capture.fence,
        request,
        media: [
          { source: input.mediaPath!, target: '/data', readOnly: false },
          { source: capture.originalsPath, target: '/import-media/source', readOnly: true },
        ],
        bootstrapAdminId: ids.bootstrapAdminId,
      },
      managerPort,
    );
  }
  /** Before install only: the app's containers get their restart policy back and run again; the copy is removed. */
  async cancelPhotoApp(operationId: string): Promise<void> {
    const operation = this.store.history().find((o) => o.id === operationId);
    if (
      !operation || operation.kind !== 'import' || typeof operation.input.commonCapture !== 'string' ||
      operation.receipts['reviewed-common-import'] !== undefined || operation.state === 'running' ||
      operation.state === 'complete' || this.executing.has(operationId)
    ) throw new Refusal('photo_app_cancel_unavailable');
    await this.recover(operationId);
  }
  /** Internal adapter handoff after snapshot, account and privacy review, with the source already fenced. */
  async prepareCommonReview(
    input: z.infer<typeof ReviewInput>,
    prepared: {
      fence: SourceFence;
      request: Pick<ImportPreparationSeal, 'operationId' | 'destinationId' | 'source'> & {
        snapshotPath?: string;
        databaseUrl?: string;
        [key: string]: unknown;
      };
      media: CommonImportReview['media'];
      bootstrapAdminId?: string;
    },
    managerPort?: number,
  ) {
    const { fence, request, media, bootstrapAdminId } = prepared;
    const { operationId, destinationId, source } = request;
    if (this.installation() || input.kind !== 'import' || input.sourceId !== fence.id || !input.mediaPath ||
      !media.some((mount) => mount.target === '/data' && mount.source === input.mediaPath && !mount.readOnly))
      throw new Refusal('invalid_import_authority');
    const captured = this.store.history().find((item) => item.id === operationId && typeof item.input.commonCapture === 'string');
    const snapshot = captured?.receipts['capture-common-source'] as PhotoAppCapture | undefined;
    const stagingRoot = join(this.directory(), `import-runtime-${operationId}`);
    const snapshotPath = snapshot?.snapshotPath && relative(stagingRoot, snapshot.snapshotPath);
    const reader = this.store.get<{ reader: string }>(`photo-app-restore:${operationId}`)?.reader;
    // Exactly the captured location: the staged SQLite snapshot, the restored copy through its reader, or for an
    // export folder neither (the preparation reads the read-only originals mount).
    const located = snapshot?.database === 'export'
      ? !!snapshot.fence.folder && !snapshot.snapshotPath && !snapshot.restore &&
        request.snapshotPath === undefined && request.databaseUrl === undefined
      : snapshot?.snapshotPath
        ? !!snapshotPath && snapshotPath !== '..' && !snapshotPath.startsWith('../') && !isAbsolute(snapshotPath) &&
          request.snapshotPath === `${IMPORT_PREPARATION_TARGET}/${snapshotPath}` && request.databaseUrl === undefined
        : !!snapshot?.restore && !!reader && request.snapshotPath === undefined &&
          request.databaseUrl === restoreDatabaseUrl(snapshot.restore, reader);
    if (
      captured?.state !== 'awaiting-review' || this.executing.has(operationId) || !snapshot || !located ||
      digest(snapshot.fence) !== digest(fence) || digest(snapshot.source) !== digest(source)
    ) throw new Refusal('invalid_import_authority');
    this.executing.add(operationId);
    try {
      await storagePath(input.mediaPath, this.roots, 0);
      const sourceRoots = fence.mounts.filter((mount) => mount.type === 'bind').map(({ source }) => source);
      for (const mount of media) {
        if (mount.target === '/data') continue;
        if (!sourceRoots.some((root) => mount.source === root || mount.source.startsWith(root + '/')) ||
          await realpath(mount.source).catch(() => null) !== mount.source)
          throw new Refusal('import_runtime_media_invalid');
      }
      const platform = (await this.docker.compatibility()).platform;
      const release = await this.releases.acquire(input.tag);
      if (!release.nas.platforms.includes(platform)) throw new Refusal('release_architecture_unavailable');
      await this.fencing.verify(fence);
      await this.docker.pull(release.nas.images.server, platform);
      this.store.delete(`review:${operationId}`);
      const path = await stageCommonImportPreparation(this.directory(), operationId, request);
      const preparationSha256 = await fileHash(path);
      const receipt = await this.docker.prepareImportBundle(this.directory(), release.nas.images.server, {
        operationId, destinationId, source, preparationSha256,
        verify: async () => {
          await this.fencing.verify(fence);
          if ((await fileHash(path)) !== preparationSha256) throw new Refusal('import_common_review_changed');
        },
      }, media, snapshot.restore?.name);
      return await this.review(input, managerPort, { ...receipt, fence, media, bootstrapAdminId });
    } finally {
      this.executing.delete(operationId);
    }
  }
  /**
   * FL-1317 Check this server: runs every check and reports them together. With a problem nothing is stored and
   * only `checks` comes back; the administrator fixes it and checks again. Install start runs the same checks.
   */
  async review(input: z.infer<typeof ReviewInput>, managerPort?: number, common?: CommonImportReview) {
    if (this.installation()) throw new Refusal('installation_already_exists');
    let source: Source | null = null,
      backup: Backup | null = null;
    if (common) {
      if (
        input.kind !== 'import' || input.sourceId !== common.fence.id ||
        !input.mediaPath || !Number.isSafeInteger(common.requiredMediaBytes) || common.requiredMediaBytes < 0 ||
        !common.media.some((mount) => mount.target === '/data' && mount.source === input.mediaPath && !mount.readOnly)
      ) throw new Refusal('invalid_import_authority');
      await this.fencing.verify(common.fence);
    } else if (input.kind === 'import') {
      // The source was reviewed on the earlier steps; one that changed since is not a server problem.
      ({ source, backup } = await this.reviewedSource(input.sourceId ?? ''));
    } else if (!input.mediaPath) throw new Refusal('media_path_required');
    const checks = await this.installChecks(input, 'review', managerPort, common, source);
    const { compatibility, databaseStorage } = checks;
    const release = !checks.blocked && compatibility
      ? await checks.run('release', async () => {
          const value = await this.releases.acquire(input.tag);
          if (!value.nas.platforms.includes(compatibility!.platform)) {
            await rm(value.directory, { recursive: true, force: true });
            throw new Refusal('release_architecture_unavailable', 409, compatibility!.platform);
          }
          return { value, outcome: { facts: { tag: value.nas.tag } } };
        })
      : undefined;
    await this.hostNotes(checks, compatibility?.memory, input.ml);
    const host = this.checkHost();
    if (!release || checks.blocked) {
      // A photo-app import has already prepared its bundle: it keeps refusing on the first problem.
      if (common) checks.assert();
      return { ready: false as const, kind: input.kind, host, checks: checks.results };
    }
    const review: Review = {
      id: common?.binding.operationId ?? randomUUID(),
      expires: Date.now() + 900_000,
      managerPort,
      input,
      release,
      source,
      ...(common && { common, approvalToken: randomUUID() }),
      backup,
      platform: compatibility!.platform,
    };
    if (common) {
      if (!this.store.createOnce(`review:${review.id}`, review)) throw new Refusal('invalid_import_authority');
    } else this.store.set(`review:${review.id}`, review);
    return {
      ready: true as const,
      host,
      checks: checks.results,
      id: review.id,
      expires: review.expires,
      kind: input.kind,
      tag: input.tag,
      databaseStorage,
      source: source
        ? {
            version: source.version,
            summary: source.summary,
            postgres: source.postgres,
            mounts: source.mounts,
            settings: Object.keys(source.settings ?? {}),
          }
        : null,
      backup: common ? null : backup ? { action: 'reuse', name: backup.name, takenAt: backup.takenAt } : { action: 'create' },
      ...(common && { approvalToken: review.approvalToken, commonImport: {
        source: common.binding.source.kind,
        version: common.binding.source.version,
        requiresBootstrap: !!common.bootstrapAdminId,
        requiredMediaBytes: common.requiredMediaBytes,
        summary: {
          owners: common.summary.owners,
          assets: common.summary.assets,
          files: common.summary.files,
          albums: common.summary.albums,
          preservationDifferences: common.summary.preservationDifferences,
        },
      } }),
      requiredBytes: (source?.summary.databaseBytes ?? 1024 ** 3) * 3,
      downtime: `${source?.product ?? 'The original app'} stays stopped while Frameleaf imports and prepares the library.`,
      recovery: common
        ? 'Manager verifies the original files before starting Frameleaf. Automatic rollback ends at the recorded writer boundary.'
        : `Database only. Photos, videos and external libraries stay in place. After Frameleaf writes to media, a database backup alone cannot safely return the library to ${source?.product ?? 'the original app'}.`,
    };
  }
  /**
   * The checks the review reports and install start repeats as its guard. Only the review creates the folders
   * chosen in setup; at install start they must still be there.
   */
  private async installChecks(
    input: z.infer<typeof ReviewInput>,
    phase: 'review' | 'start',
    managerPort?: number,
    common?: CommonImportReview,
    source?: Source | null,
  ) {
    const checks = new ServerCheck();
    const broad = broadRoots(this.roots);
    const backups = input.backupPath ?? process.env.MANAGER_BACKUP_ROOT!;
    // Each folder by its role: the same path chosen for two roles is still refused.
    const chosen = Object.entries({ media: input.mediaPath, database: input.databaseRoot, backups, state: this.store.directory })
      .filter((entry): entry is [string, string] => !!entry[1]);
    const databaseBytes = (source?.summary.databaseBytes ?? 1024 ** 3) * 3;
    // A folder chosen in setup must be its own, and exist (the review creates it, empty).
    const chosenFolder = async (role: string, path: string) => {
      if (!broad) return;
      for (const [other, otherPath] of chosen) if (other !== role) assertSeparateFolders([path, otherPath]);
      if (phase === 'review') await ensureChosenFolder(path);
    };
    const compatibility = await checks.run('docker', async () => {
      const value = await this.docker.compatibility();
      return { value, outcome: { facts: { version: value.version ?? null } } };
    });
    await this.roomCheck(checks, input.ml);
    await checks.run('media', async () => {
      if (source) {
        // FL-1320: a source folder on a drive that isn't mounted is named plainly.
        await assertMountSources(source.mounts);
        return { outcome: { facts: { folders: source.mounts.length } as CheckFacts } };
      }
      await chosenFolder('media', input.mediaPath!);
      const path = await storagePath(input.mediaPath!, this.roots, common?.requiredMediaBytes ?? 1024 ** 3);
      return { outcome: { facts: { path, free: await freeBytes(path) } } };
    });
    const databaseStorage = await checks.run('database', async () => {
      await chosenFolder('database', input.databaseRoot);
      const value = await this.databaseStorage.validate(input.databaseRoot, databaseBytes);
      return { value, outcome: { facts: { path: input.databaseRoot, free: await freeBytes(input.databaseRoot) } } };
    });
    await checks.run('backups', async () => {
      await chosenFolder('backups', backups);
      return { outcome: { facts: { path: backups, free: await freeBytes(backups) } } };
    });
    // Database backups and recovery points are written through Manager's own folder first: its own result, since
    // choosing another backups folder can't free it.
    await checks.run('manager', async () => {
      await storagePath(this.store.directory, [this.store.directory], databaseBytes);
      return { outcome: { facts: { path: this.store.directory, free: await freeBytes(this.store.directory) } } };
    });
    await this.portCheck(checks, input.port, null, common?.fence ?? source, managerPort, true);
    if (Object.keys(input.services ?? {}).length)
      await checks.run('containers', async () => {
        // The same conflict check the stack generator runs, against the mounts this installation will have.
        checkServiceOverrides((source?.mounts ?? [{ target: '/data' }]).map(({ target }) => target), input.services ?? {}, this.mountRoots());
        this.checkExternalFolders(input.services ?? {}, [input.mediaPath ?? '', input.databaseRoot], input.backupPath);
      });
    await this.downloadsCheck(checks);
    return Object.assign(checks, { compatibility, databaseStorage });
  }
  /** The host whose checks and fix steps Check this server shows (MANAGER_PLATFORM, else what Manager detected). */
  checkHost() {
    return checkHost();
  }
  /** FL-1318: room in Docker's own storage for the images this install downloads; less without machine learning. */
  private async roomCheck(checks: ServerCheck, ml: boolean): Promise<void> {
    const needed = dockerRoomNeeded(ml, ml ? await detectAcceleration() : 'cpu');
    const free = await this.probes.dockerFree().catch(() => null);
    await checks.run('room', async (): Promise<{ outcome: CheckOutcome }> => {
      if (free === null) return { outcome: { status: 'unknown', code: 'docker_storage_unreadable', facts: { needed } } };
      if (free < needed) throw new Refusal('insufficient_docker_space', 409);
      return { outcome: { facts: { needed, free } } };
    });
    if (free !== null && free < needed) checks.annotate('room', { needed, free });
  }
  /** FL-1318: the image registry and the release host answer from this server before anything downloads. */
  private async downloadsCheck(checks: ServerCheck): Promise<void> {
    await checks.run('downloads', async () => {
      const answered = await Promise.all(DOWNLOAD_HOSTS.map((host) => this.probes.reaches(downloadUrl(host)).catch(() => false)));
      const silent = DOWNLOAD_HOSTS.find((_, index) => !answered[index]);
      if (silent) throw new Refusal('download_host_unreachable', 503, silent);
    });
  }
  /**
   * The port check. checkPort sees only containers; FL-1318 also tests the host's own listeners from a helper on its
   * network. A port a container publishes is the container check's call (an import reuses its source's port).
   */
  private async portCheck(
    checks: ServerCheck,
    port: number,
    installation: Installation | null,
    source: Source | SourceFence | null | undefined,
    managerPort: number | undefined,
    offerFree: boolean,
  ): Promise<void> {
    await checks.run(
      'port',
      async () => {
        await this.checkPort(port, installation, source, managerPort);
        const open = await this.probes.hostFreePorts([port]);
        if (!open) return { outcome: { status: 'unknown', code: 'host_port_unchecked', facts: { port } } };
        if (!open.includes(port) && !(await this.publishedPorts()).has(port)) throw new Refusal('port_in_use');
        return { outcome: { facts: { port } } };
      },
      { unknownOnError: true },
    );
    if (checks.results.at(-1)?.code === 'port_in_use')
      checks.annotate('port', { port, ...(offerFree && { free: await this.freePort(port, source, managerPort) }) });
  }
  /** Ports running containers publish on this server. */
  private async publishedPorts(): Promise<Set<number>> {
    return new Set(
      (await this.docker.inventory())
        .filter((c) => c.State.Running)
        .flatMap((c) => Object.values(c.HostConfig.PortBindings ?? {}).flatMap((values) => (values ?? []).map((v) => Number(v.HostPort)))),
    );
  }
  /** FL-1318: worth knowing, never blocking: memory for machine learning, and Unraid's Docker tab. */
  private async hostNotes(checks: ServerCheck, dockerMemory: number | null | undefined, ml: boolean): Promise<void> {
    await checks.run(
      'memory',
      async () => {
        // Docker's answer first; when Docker itself is the problem, what Manager's own container sees.
        const memory = dockerMemory || this.probes.memory();
        if (!memory) return { outcome: { status: 'unknown', code: 'memory_unknown' } };
        return { outcome: { facts: { bytes: memory, ml }, ...(ml && memory < LOW_MEMORY && { status: 'warning' as const, code: 'low_memory' }) } };
      },
      { unknownOnError: true },
    );
    if (this.checkHost() === 'unraid')
      await checks.run(
        'unraid',
        async () => ((await this.probes.dockermanMapped()) ? {} : { outcome: { status: 'warning', code: 'dockerman_templates_unmapped' } }),
        { unknownOnError: true },
      );
  }
  /** The next port after `port` that nothing on this server publishes, for "Use port 2284". Null when none is near. */
  private async freePort(port: number, source?: Source | SourceFence | null, managerPort?: number): Promise<number | null> {
    const candidates = Array.from({ length: Math.min(65535, port + 50) - port }, (_, index) => port + 1 + index);
    // Ports a host app listens on are skipped too, when the helper can tell.
    const open = await this.probes.hostFreePorts(candidates).catch(() => null);
    for (const next of candidates)
      if ((!open || open.includes(next)) && (await this.checkPort(next, null, source, managerPort).then(() => true, () => false))) return next;
    return null;
  }
  /**
   * An import may reuse its reviewed writers' ports: source fencing stops them before Frameleaf starts.
   * Legacy Immich cutover also retires its database; shared sources do not yet promise that retirement.
   */
  async checkPort(port: number, installation?: Installation | null, source?: Source | SourceFence | null, managerPort?: number): Promise<void> {
    const containers = await this.docker.inventory();
    const replaced = new Set(source?.workers ?? []);
    if (source && !('containers' in source)) replaced.add(source.database.container);
    // Manager's own published port (review L2): the port the request came in on, and whatever the host
    // publishes for this Manager container, so an unset MANAGER_ORIGIN cannot leave the guess at 2282.
    // Docker's bind at compose up remains the final authority for ports used by non-container host processes.
    const own = new Set([
      Number(new URL(process.env.MANAGER_ORIGIN || 'https://localhost:2282').port || 443),
      ...(managerPort ? [managerPort] : []),
      ...containers
        .filter(
          (c) =>
            c.Config.Labels?.['app.frameleaf.manager.role'] === 'controller' &&
            environment(c).MANAGER_DATA === this.store.directory,
        )
        .flatMap((c) =>
          Object.values(c.HostConfig.PortBindings ?? {}).flatMap((values) => (values ?? []).map((v) => Number(v.HostPort))),
        ),
    ]);
    if (own.has(port)) throw new Refusal('port_in_use');
    if (
      containers.some(
        (c) =>
          c.State.Running &&
          !replaced.has(c.Id) &&
          (!installation || c.Config.Labels?.['app.frameleaf.manager'] !== installation.id) &&
          Object.values(c.HostConfig.PortBindings ?? {}).some((values) =>
            values?.some((v) => Number(v.HostPort) === port),
          ),
      )
    )
      throw new Refusal('port_in_use');
  }
  start(reviewId: string, key: string, bootstrap?: unknown, approvalToken?: string): Operation {
    const prior = this.store.request(undefined, key, { reviewId });
    if (prior) {
      if (!['install', 'import'].includes(prior.kind)) throw new Refusal('request_key_reused');
      return prior;
    }
    const captured = this.store.history().find((item) => item.id === reviewId && typeof item.input.commonCapture === 'string');
    if (captured?.receipts['common-approval-key'] !== undefined) {
      if (captured.receipts['common-approval-key'] !== key) throw new Refusal('request_key_reused');
      if (captured.receipts['common-approval-token'] !== approvalToken) throw new Refusal('invalid_import_authority');
      return captured;
    }
    const review = this.store.get<Review>(`review:${reviewId}`);
    if (!review || review.expires < Date.now()) throw new Refusal('review_expired');
    if (review.common && (review.id !== reviewId || review.common.binding.operationId !== reviewId || review.source))
      throw new Refusal('invalid_import_authority');
    if (review.approvalToken !== approvalToken) throw new Refusal('invalid_import_authority');
    if (!!review.common?.bootstrapAdminId !== (bootstrap !== undefined))
      throw new Refusal('import_bootstrap_credentials_required');
    if (captured) {
      const snapshot = captured.receipts['capture-common-source'] as PhotoAppCapture | undefined;
      if (
        !review.common || !approvalToken || captured.state !== 'awaiting-review' || this.executing.has(captured.id) ||
        !snapshot || digest(snapshot.fence) !== digest(review.common.fence) ||
        digest(snapshot.source) !== digest(review.common.binding.source)
      ) throw new Refusal('invalid_import_authority');
      captured.receipts['reviewed-common-import'] = digest(review.common);
      captured.receipts['common-approval-key'] = key;
      captured.receipts['common-approval-token'] = approvalToken;
      captured.state = 'running';
      this.store.save(captured);
      this.launch(captured, () => this.install(captured, review, bootstrap));
      return captured;
    }
    const { operation, created } = this.store.start(
      review.input.kind, key, { reviewId }, review.common ? { id: reviewId, sha256: digest(review.common) } : undefined,
    );
    if (created) this.launch(operation, () => this.install(operation, review, bootstrap));
    return operation;
  }
  /** Runs an operation in the background, journalling and logging how it ends. */
  private launch(operation: Operation, work: () => Promise<void>): void {
    this.executing.add(operation.id);
    const started = Date.now();
    log(`${operation.kind} ${operation.id}: started`);
    void work()
      .then(() => {
        if (operation.state !== 'awaiting-review') operation.state = 'complete';
        operation.error = (operation.receipts['cancelled'] as string | undefined) ?? null;
        this.store.save(operation);
        log(`${operation.kind} ${operation.id}: ${operation.state}${operation.error ? ` (${operation.error})` : ''} in ${elapsed(started)}`);
      })
      .catch((error) => {
        operation.state = 'failed';
        operation.error = error instanceof Refusal ? error.code : 'operation_failed';
        operation.detail = error instanceof Refusal ? (error.detail ?? null) : null;
        // Codes and refusal details reach the journal; the container log says which step failed and why.
        console.error(
          redact(`manager: ${operation.kind} failed at ${operation.step ?? 'start'}: ${operation.error}` +
            (error instanceof Refusal ? (error.detail ? ` (${error.detail})` : '') : ` (${(error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? error})`)),
        );
        this.store.save(operation);
      })
      .finally(async () => {
        // FL-1242: the destination administrator's password never outlives the run that staged it.
        if (
          operation.kind === 'import' &&
          operation.state !== 'running' &&
          (operation.completed.includes('stage-bootstrap-admin') || operation.step === 'stage-bootstrap-admin')
        )
          await removeCommonImportBootstrap(this.directory(), operation.id).catch((error) =>
            console.error(`manager: could not remove the staged import administrator: ${error?.code ?? error}`),
          );
        this.executing.delete(operation.id);
        // A settled operation no longer needs its plaintext dump, recovery record or restored snapshot.
        void this.retention.sweep();
      });
  }
  resume(id: string, bootstrap?: unknown): Operation {
    const operation = this.store.history().find((o) => o.id === id);
    if (!operation || this.executing.has(id) || !['failed', 'interrupted'].includes(operation.state))
      throw new Refusal('operation_not_recoverable');
    if (bootstrap !== undefined && (
      operation.kind !== 'import' ||
      operation.receipts['cancellation-intent'] ||
      operation.completed.includes('preflight-common-import') ||
      !this.store.get<Review>(`review:${operation.input.commonCapture ? operation.id : operation.input.reviewId}`)?.common?.bootstrapAdminId
    )) throw new Refusal('invalid_import_authority');
    operation.state = 'running';
    operation.error = null;
    operation.detail = null;
    this.store.save(operation);
    this.launch(operation, async () => {
      if (operation.receipts['cancellation-intent']) return this.cancelOperation(operation);
      if (operation.kind === 'import' && typeof operation.input.commonCapture === 'string' &&
        !operation.receipts['reviewed-common-import']) {
        return this.captureForReview(operation);
      }
      if (operation.kind === 'move-library') return this.applyMove(operation);
      if (operation.kind === 'move-database') {
        const review = this.store.get<DatabaseRelocationReview>(`database-move:${operation.input.reviewId}`);
        if (!review) throw new Refusal('review_missing');
        return this.applyDatabaseRelocation(operation, review);
      }
      if (operation.kind === 'update') {
        const review = this.store.get<UpdateReview>(`update:${operation.input.reviewId}`);
        if (!review) throw new Refusal('review_missing');
        return this.applyUpdate(operation, await this.retargetWithdrawnUpdate(operation, review));
      }
      if (['start', 'stop', 'restart', 'backup'].includes(operation.kind)) return this.runControl(operation);
      if (operation.kind === 'reconfigure') return this.applyReconfigure(operation);
      const restoring = operation.kind === 'restore';
      const review = this.store.get<Review | RestoreReview>(
        `${restoring ? 'restore' : 'review'}:${operation.input.commonCapture ? operation.id : operation.input.reviewId}`,
      );
      if (!review) throw new Refusal('review_missing');
      const installation = this.installation();
      if (
        installation &&
        !operation.completed.includes('configure') &&
        !operation.receipts['configuration-intent'] &&
        !(restoring && digest(installation) === digest((review as RestoreReview).current))
      )
        throw new Refusal('configuration_recovery_required');
      if (!restoring) assertCommonImportReview(operation, (review as Review).common);
      const sourceFence = restoring ? null : ((review as Review).common?.fence ?? (review as Review).source);
      if (sourceFence && operation.completed.includes('fence-source')) {
        await this.verifySourceUntilTakeover(sourceFence, installation ?? undefined);
        if (installation) await this.fencing.assertMedia(installation.mounts, installation);
      }
      if (operation.step === 'restore-new-database' && !operation.completed.includes('restore-new-database')) {
        if (!installation || installation.mayHaveWrittenMedia) throw new Refusal('manual_media_recovery_required');
        // pg_restore may have committed before Manager died. Never replay it against that directory.
        // Stop the old DB, retain its files, and allocate a different empty host folder for this attempt.
        await this.docker.compose(this.directory(), installation.project, 'stop', ['database']);
        const retired = this.store.get<string[]>('retained-database-directories') ?? [];
        this.store.set('retained-database-directories', [...new Set([...retired, installation.databasePath])]);
        installation.databasePath = await this.databaseStorage.allocate(
          installation.databaseRoot,
          installation.id,
          restoring
            ? (review as RestoreReview).databaseBytes
            : ((review as Review).source?.summary.databaseBytes ?? 1024 ** 3) * 3,
        );
        this.store.set('installation', installation);
        operation.receipts.configure = installation;
        this.store.save(operation);
        await renderCompose(
          review.release,
          installation,
          this.store.get<string>('database-password')!,
          this.directory(),
          this.application(),
        );
        await this.docker.compose(this.directory(), installation.project, 'up', ['database']);
      }
      if (restoring) await this.applyRestore(operation, review as RestoreReview);
      else await this.install(operation, review as Review, bootstrap);
    });
    return operation;
  }
  /** Runs one journalled step once (a completed step returns its receipt), logging start, finish and failure. */
  private async step<T>(operation: Operation, name: string, action: () => Promise<T>): Promise<T> {
    if (operation.completed.includes(name)) return operation.receipts[name] as T;
    operation.step = name;
    this.store.save(operation); // fsync'd intent precedes the external effect
    const started = Date.now();
    log(`${operation.kind} ${operation.id}: ${name} started`);
    const receipt = await action().catch((error) => {
      log(`${operation.kind} ${operation.id}: ${name} failed after ${elapsed(started)}`);
      throw error;
    });
    operation.receipts[name] = receipt ?? null;
    operation.completed.push(name);
    operation.step = null;
    this.store.save(operation);
    log(`${operation.kind} ${operation.id}: ${name} finished in ${elapsed(started)}`);
    return receipt;
  }
  private async install(operation: Operation, review: Review, bootstrap?: unknown): Promise<void> {
    const common = review.common;
    assertCommonImportReview(operation, common);
    if (common && (operation.kind !== 'import' || review.source)) throw new Refusal('invalid_import_authority');
    const sourceFence = common?.fence ?? review.source;
    this.adoptChosenBackupFolder(review.input.backupPath);
    await this.step(operation, 'preflight', async () => {
      if (this.installation()) throw new Refusal('installation_already_exists');
      await this.releases.eligible(review.input.tag);
      if (common) await this.fencing.verify(common.fence);
      else if (sourceFence) await this.discovery.revalidate(sourceFence);
      // FL-1317: the review's checks again, so a change since the review still refuses before any download.
      (await this.installChecks(review.input, 'start', review.managerPort, common, review.source)).assert();
      return true;
    });
    if (common?.bootstrapAdminId && !operation.completed.includes('preflight-common-import')) {
      const stage = async () => {
        if (bootstrap === undefined) throw new Refusal('import_bootstrap_credentials_required');
        const root = join(this.directory(), `import-runtime-${operation.id}`);
        await prepareCommonImportRuntime(root, operation.id, common.destinationId, common.bundleName, common.bootstrapAdminId);
        await stageCommonImportBootstrap(this.directory(), {
          operationId: operation.id,
          destinationId: common.destinationId,
          userId: common.bootstrapAdminId!,
        }, bootstrap);
        return true;
      };
      if (operation.completed.includes('stage-bootstrap-admin')) {
        if (bootstrap !== undefined) await stage();
        // A run that stopped removed the staged password (FL-1242): the administrator enters it again to resume.
        else if (!(await commonImportBootstrapStaged(this.directory(), operation.id)))
          throw new Refusal('import_bootstrap_credentials_required');
      } else await this.step(operation, 'stage-bootstrap-admin', stage);
    }
    await this.step(operation, 'download-images', async () => {
      const release = await this.releases.verify(review.release.directory, review.input.tag);
      for (const image of await releaseImages(release.nas.images, review.input))
        await this.docker.pull(image, review.platform);
      return release.nas.tag;
    });
    const installation = await this.step(operation, 'configure', async () => {
      let intent = operation.receipts['configuration-intent'] as
        { installation: Installation; password: string } | undefined;
      if (!intent) {
        const id = await this.newInstallationId();
        const databasePath = await this.databaseStorage.allocate(
          review.input.databaseRoot,
          id,
          (review.source?.summary.databaseBytes ?? 1024 ** 3) * 3,
        );
        const result: Installation = {
          id,
          name: review.input.name,
          project: `frameleaf-${id}`,
          release: review.input.tag,
          port: review.input.port,
          ml: review.input.ml,
          origin: sourceFence ? 'new_import' : 'new_library',
          mounts: review.source?.mounts ?? [
            { type: 'bind', source: review.input.mediaPath!, target: '/data', readOnly: false },
          ],
          sourceId: sourceFence?.id ?? null,
          mayHaveWrittenMedia: false,
          databaseRoot: review.input.databaseRoot,
          databasePath,
        };
        intent = { installation: result, password: randomBytes(48).toString('base64url') };
        operation.receipts['configuration-intent'] = intent;
        this.store.save(operation);
      }
      const { installation: result, password } = intent;
      this.store.set('database-password', password);
      this.store.set('installation', result);
      this.store.set('application-config', {
        environment: review.source?.environment ?? {},
        settings: review.source?.settings ?? null,
        authority: review.source?.settingsAuthority ?? 'database',
        services: review.input.services ?? {},
      });
      await mkdir(this.directory(), { recursive: true, mode: 0o700 });
      await this.managerToken();
      await renderCompose(review.release, result, password, this.directory(), this.application());
      return result;
    });
    const source = review.source;
    if (source) {
      await this.step(operation, 'review-source', async () => {
        await this.discovery.revalidate(source);
        // A backup might have expired while images downloaded. Re-evaluate immediately before stopping.
        const backup = recentBackup(await sourceBackups(this.docker, source), source);
        if (review.backup && (!backup || backup.sha256 !== review.backup.sha256))
          throw new Refusal('backup_changed_review_again');
        return true;
      });
      await this.step(operation, 'fence-source', async () => {
        await this.fencing.stop(source);
        return true;
      });
    }
    if (common) await this.step(operation, 'fence-source', async () => {
      await this.fencing.stop(common.fence);
      return true;
    });
    await this.step(operation, 'start-database', async () => {
      await this.databaseStorage.verify(installation);
      await this.docker.compose(this.directory(), installation.project, 'up', ['database']);
      return true;
    });
    if (source) {
      await this.step(operation, 'capture-fenced-settings', async () => {
        await this.fencing.verify(source);
        const fenced =
          source.settingsAuthority === 'database'
            ? JSON.parse(
                await this.docker.sql(
                  source.database,
                  `SELECT coalesce((SELECT value FROM public.system_metadata WHERE key='system-config'), '{}'::jsonb);`,
                ),
              )
            : source.settings;
        // An edit made against settings that changed before the source stopped is not applied blind.
        if (source.settingsBase && source.settingsAuthority === 'database' && digest(fenced) !== source.settingsBase)
          throw new Refusal('source_changed_review_again');
        const settings = source.settingsBase ? source.settings : fenced;
        if (
          settings &&
          (typeof settings !== 'object' ||
            Array.isArray(settings) ||
            Object.keys(settings).some((key) => !COMPATIBLE_SETTINGS.includes(key)))
        )
          throw new Refusal('incompatible_fenced_settings');
        const application = ApplicationConfig.parse({ ...this.application(), settings });
        this.store.set('application-config', application);
        await renderCompose(
          review.release,
          installation,
          this.store.get<string>('database-password')!,
          this.directory(),
          application,
        );
        return application;
      });
      const dump = join(this.store.directory, 'imports', `${operation.id}.dump`);
      await this.step(operation, 'copy-current-database', async () => {
        await this.fencing.verify(source);
        await mkdir(join(this.store.directory, 'imports'), { recursive: true, mode: 0o700 });
        // A completed transfer can survive a lost journal acknowledgement; verification reuses it.
        try {
          await stat(dump);
        } catch {
          await this.docker.dump(source.database, dump);
        }
        await this.docker.verifyDump(source.database, dump);
        // Only the stopped source is authoritative; discovery counts can change during downloads.
        const summary = JSON.parse(
          await this.docker.sql(
            source.database,
            `SELECT json_build_object('users', (SELECT count(*) FROM public.user),
          'assets', (SELECT count(*) FROM public.asset), 'albums', (SELECT count(*) FROM public.album));`,
          ),
        );
        return { file: dump, sha256: await fileHash(dump), summary };
      });
      if (!review.backup)
        await this.step(operation, 'database-backup', async () => {
          await this.backups.initialize();
          const checkpoint = await this.checkpoint(operation, dump);
          return this.backups.snapshot(checkpoint, operation.id);
        });
      // FL-414: after the import, Frameleaf stores identical files once and recovers orphaned files in
      // place, so every media folder it keeps must be writable. Checked before anything is imported.
      await this.step(operation, 'check-media-writable', async () => {
        const targets = installation.mounts.filter((mount) => !mount.readOnly).map((mount) => mount.target);
        const blocked = await this.docker.unwritableMedia(this.directory(), installation.project, targets);
        if (blocked.length > 0)
          throw new Refusal(
            'media_folder_not_writable',
            409,
            `Frameleaf must be able to write to every media folder: after the import it stores identical files once and recovers orphaned files where they are. Make these folders writable for the Frameleaf server, then try again: ${blocked.join(', ')}.`,
          );
        return { writable: targets };
      });
      await this.step(operation, 'configure-offline-import', async () => {
        await this.fencing.verify(source);
        await this.configureImport(operation, review, installation);
        return true;
      });
      await this.step(operation, 'import-canonical-database', async () => {
        await this.fencing.verify(source);
        const state = await this.runImport(operation, review, installation, 'status');
        if (state.status === 'abandoned') throw new Refusal('import_abandoned_requires_fresh_database');
        if (state.status !== 'activated') {
          await this.runImport(operation, review, installation, state.status === 'fresh' ? 'run' : 'resume');
          await this.fencing.verify(source);
          await this.runImport(operation, review, installation, 'verify');
        }
        return true;
      });
      await this.step(operation, 'verify-import', async () => {
        await this.fencing.verify(source);
        const state = await this.runImport(operation, review, installation, 'status');
        if (state.status !== 'activated') throw new Refusal('import_verification_failed');
        const db = await this.targetDatabase();
        const result = JSON.parse(
          await this.docker.sql(
            db,
            `SELECT json_build_object('users',(SELECT count(*) FROM public.user),
          'assets',(SELECT count(*) FROM public.asset),'albums',(SELECT count(*) FROM public.album));`,
          ),
        );
        const receipt = operation.receipts['copy-current-database'] as { summary: Record<string, number> };
        if (['users', 'assets', 'albums'].some((k) => result[k] !== receipt.summary[k]))
          throw new Refusal('import_verification_failed');
        // The frozen importer owns canonical row/permission/checksum verification. Manager owns cutover.
        return { countsMatch: true, activated: true };
      });
      await this.step(operation, 'import-settings', async () => {
        if (source.settingsAuthority === 'database') {
          const captured = operation.receipts['capture-fenced-settings'] as ApplicationConfig;
          const settings = JSON.stringify({
            ...captured.settings,
            machineLearning: {
              ...(captured.settings?.machineLearning as Record<string, unknown> | undefined),
              enabled: installation.ml,
              urls: ['http://frameleaf-machine-learning:3003'],
            },
          }).replaceAll("'", "''");
          await this.docker.sql(
            await this.targetDatabase(),
            `INSERT INTO public.system_metadata (key,value) VALUES ('system-config','${settings}'::jsonb)
             ON CONFLICT (key) DO UPDATE SET value=excluded.value;`,
          );
        }
        const reader = this.store.get<{ name: string }>(`import-reader:${operation.id}`)!;
        await this.docker.sql(source.database, `ALTER ROLE "${reader.name}" NOLOGIN;`);
        return true;
      });
      // FL-476: the verified import was the source database's last reader (import-settings above still used it).
      // Safe default: stop it and its Redis, with no restart policy and no Unraid autostart; recovery restores them.
      await this.step(operation, 'retire-source-services', async () =>
        (await this.fencing.retireSourceServices(source)).map((s) => ({ role: s.role, name: s.name })),
      );
    }
    if (common) await this.runCommonImport(operation, common, installation);
    // The bundle is imported: the restored source copy and the plan's source login are no longer needed.
    if (common && typeof operation.input.commonCapture === 'string')
      await this.step(operation, 'remove-source-copy', async () => {
        await this.removePhotoAppCopy(operation);
        return true;
      });
    await this.step(operation, 'start-frameleaf', async () => {
      if (sourceFence) await this.verifySourceUntilTakeover(sourceFence);
      await this.fencing.assertMedia(installation.mounts, installation);
      await this.releases.eligible(review.input.tag);
      installation.mayHaveWrittenMedia = true;
      this.store.set('installation', installation);
      try {
        await this.docker.compose(this.directory(), installation.project, 'up');
      } catch (error) {
        // A server that never started wrote no media, so this setup can still be cancelled.
        if (!common && !(await this.serverStarted(installation))) {
          installation.mayHaveWrittenMedia = false;
          this.store.set('installation', installation);
        }
        throw error;
      }
      return true;
    });
    await this.step(operation, 'prepare-library', async () => this.libraryStatus(true));
  }
  private async runCommonImport(operation: Operation, common: CommonImportReview, installation: Installation) {
    const destination = installation.mounts.find((mount) => mount.target === '/data');
    if (
      operation.kind !== 'import' ||
      common.binding.operationId !== operation.id ||
      installation.origin !== 'new_import' ||
      installation.sourceId !== common.fence.id ||
      destination?.type !== 'bind' || destination.readOnly ||
      !common.media.some((mount) => mount.target === '/data' && mount.source === destination.source && !mount.readOnly)
    ) throw new Refusal('invalid_import_authority');
    await this.step(operation, 'import-canonical-database', async () => {
      await this.docker.completeReviewedImport(
        this.directory(),
        installation.project,
        {
          installation: installation.id,
          destinationId: common.destinationId,
          binding: common.binding,
          verify: () => this.fencing.verify(common.fence, installation),
        },
        common.media,
        async (preflight) => {
          await this.step(operation, 'preflight-common-import', async () => {
            const report = await preflight();
            if (
              report.requiredMediaBytes !== common.requiredMediaBytes ||
              !Object.entries(common.summary).every(([name, count]) => report.summary?.[name] === count)
            ) throw new Refusal('import_common_review_changed');
            return true;
          });
          if (common.bootstrapAdminId) await removeCommonImportBootstrap(this.directory(), operation.id);
          operation.step = 'import-canonical-database';
          this.store.save(operation);
        },
        async () => {
          installation.mayHaveWrittenMedia = true;
          this.store.set('installation', installation);
        },
        common.bundleName,
        common.bootstrapAdminId,
      );
      return true;
    });
  }
  private async runImport(
    operation: Operation,
    review: Review,
    installation: Installation,
    action: 'status' | 'run' | 'resume' | 'verify',
  ) {
    await this.fencing.verify(review.source!);
    // Refresh only transport addresses; logical config and source identities remain journal-pinned.
    await this.configureImport(operation, review, installation);
    return this.docker.importCommand(this.directory(), installation.project, operation.id, action);
  }
  private async configureImport(operation: Operation, review: Review, installation: Installation): Promise<void> {
    const source = review.source!;
    if (
      operation.kind !== 'import' ||
      installation.origin !== 'new_import' ||
      !/^[a-f0-9]{12}$/.test(installation.id) ||
      installation.sourceId !== source.id
    )
      throw new Refusal('invalid_import_authority');
    if (
      (await this.docker.inventory()).some(
        (c) => c.Config.Labels?.['app.frameleaf.manager.import'] === operation.id && c.State.Running,
      )
    )
      throw new Refusal('import_still_running_retry_when_stopped');
    let reader = this.store.get<{ name: string; password: string }>(`import-reader:${operation.id}`);
    if (!reader) {
      reader = {
        name: `frameleaf_import_${randomBytes(12).toString('hex')}`,
        password: randomBytes(32).toString('hex'),
      };
      this.store.set(`import-reader:${operation.id}`, reader);
    }
    // Only role grants are changed on the stopped source. No content, schema or source migration runs.
    const database = source.database.name.replaceAll('"', '""');
    await this.docker.sql(
      source.database,
      `DO $role$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${reader.name}') THEN
        CREATE ROLE "${reader.name}" LOGIN PASSWORD '${reader.password}' NOSUPERUSER NOBYPASSRLS NOINHERIT;
      END IF; END $role$;
      ALTER ROLE "${reader.name}" INHERIT;
      GRANT pg_read_all_stats TO "${reader.name}";
      GRANT CONNECT ON DATABASE "${database}" TO "${reader.name}";
      GRANT USAGE ON SCHEMA public TO "${reader.name}";
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${reader.name}";
      GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO "${reader.name}";`,
    );
    const container = await this.docker.inspect(source.database.container);
    const network = Object.entries(container.NetworkSettings.Networks).find(([, value]) => value.IPAddress);
    if (!network) throw new Refusal('source_database_network_unavailable');
    const destination = await this.docker.inspect((await this.targetDatabase()).container);
    const destinationIp = destination.NetworkSettings.Networks[`${installation.project}_default`]?.IPAddress;
    if (!destinationIp) throw new Refusal('target_database_network_unavailable');
    const url = (host: string, name: string, user: string, password: string, port: number) => {
      const value = new URL(`postgresql://${host}:${port}`);
      value.username = user;
      value.password = password;
      value.pathname = `/${encodeURIComponent(name)}`;
      return value.toString();
    };
    const config = {
      version: source.version.replace(/^v/, ''),
      ...(source.product === 'Noodle Gallery' && { product: source.product }),
      sourceId: source.id,
      writersStopped: true,
      media: {
        mode: 'manager-in-place',
        authority: 'frameleaf-manager',
        operationId: operation.id,
        deploymentId: installation.id,
      },
      mediaRoots: installation.mounts.map((mount) => ({ source: mount.target, target: mount.target })),
    };
    await atomicJson(join(this.directory(), 'import.json'), config);
    const compose = JSON.parse(await readFile(join(this.directory(), 'compose.json'), 'utf8'));
    const app = compose.services['frameleaf-server'];
    app.environment = {
      DB_URL: url(destinationIp, 'frameleaf', 'frameleaf', this.store.get<string>('database-password')!, 5432),
      FRAMELEAF_IMPORT_SOURCE_URL: url(
        network[1].IPAddress,
        source.database.name,
        reader.name,
        reader.password,
        source.database.port,
      ),
      FRAMELEAF_MANAGER_ORIGIN: installation.origin,
      FRAMELEAF_MANAGER_INSTALLATION: config.media.deploymentId,
      FRAMELEAF_IMPORT_MANAGER_OPERATION_ID: config.media.operationId,
      ...(source.environment.IMMICH_MEDIA_LOCATION
        ? { IMMICH_MEDIA_LOCATION: source.environment.IMMICH_MEDIA_LOCATION }
        : {}),
    };
    // Dedicated CLI container can read every reviewed media mapping, but cannot mutate any media.
    // It never enrols the Studio worker, so it does not get that volume (FL-408).
    app.volumes = app.volumes
      .filter((mount: Record<string, unknown>) => mount.target !== STUDIO_WORKER_TARGET)
      .map((mount: Record<string, unknown>) => ({ ...mount, read_only: true }));
    app.volumes.push({
      type: 'bind',
      source: join(this.directory(), 'import.json').replaceAll('$', () => '$$'),
      target: '/run/frameleaf/import.json',
      read_only: true,
      bind: { create_host_path: false },
    });
    app.labels['app.frameleaf.manager.import'] = operation.id;
    app.networks = ['default', 'import-source'];
    delete app.ports;
    delete app.depends_on;
    delete app.healthcheck;
    app.restart = 'no';
    app.logging = { driver: 'none' };
    compose.networks['import-source'] = { external: true, name: network[0].replaceAll('$', () => '$$') };
    // Compose interpolates strings even in JSON. The generated runtime-only credentials stay private.
    const escaped = JSON.parse(
      JSON.stringify(app.environment, (_key, value) =>
        typeof value === 'string' ? value.replaceAll('$', () => '$$') : value,
      ),
    );
    app.environment = escaped;
    await atomicJson(join(this.directory(), 'import-compose.json'), compose);
  }
  async libraryStatus(begin = false): Promise<unknown> {
    if (!this.installation()) return null;
    return this.serverRequest(begin ? 'POST' : 'GET', 'library-setup/manager');
  }
  /** The owner would rather let the server run: setup releases its held work and stops asking. */
  async dismissLibrarySetup(): Promise<unknown> {
    if (!this.installation()) return null;
    return this.serverRequest('DELETE', 'library-setup/manager');
  }
  async targetDatabase(installation = this.installation()): Promise<Database> {
    if (!installation) throw new Refusal('no_installation');
    await this.databaseStorage.verify(installation);
    const db = (await this.docker.inventory()).filter(
      (c) =>
        c.Config.Labels?.['app.frameleaf.manager'] === installation.id &&
        c.Config.Labels?.['com.docker.compose.service'] === 'database',
    );
    if (
      db.length !== 1 ||
      !db[0].Mounts.some(
        (m) =>
          m.Type === 'bind' &&
          m.Source === installation.databasePath &&
          m.RW &&
          m.Destination === '/var/lib/postgresql',
      )
    )
      throw new Refusal('managed_database_unavailable');
    return {
      container: db[0].Id,
      host: 'database',
      port: 5432,
      name: 'frameleaf',
      user: 'frameleaf',
      password: this.store.get<string>('database-password')!,
    };
  }
  private async managerToken(): Promise<void> {
    const file = join(this.directory(), 'manager-token');
    try {
      if (!/^[a-f0-9]{64}$/.test(await readFile(file, 'utf8'))) throw new Refusal('manager_token_invalid');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    }
  }
  private async checkpoint(operation: Operation, dump?: string): Promise<string> {
    const path = join(this.store.directory, 'checkpoints', operation.id);
    await mkdir(path, { recursive: true, mode: 0o700 });
    let receipt = operation.receipts['checkpoint-dump'] as { sha256: string } | undefined;
    const target = join(path, 'database.dump');
    if (dump) {
      const imported = operation.receipts['copy-current-database'] as { sha256: string };
      await copyVerified(dump, target, imported.sha256);
      receipt = { sha256: imported.sha256 };
    } else if (!receipt) {
      try {
        await stat(target);
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        await this.docker.dump(await this.targetDatabase(), target);
      }
      await this.docker.verifyDump(await this.targetDatabase(), target);
      receipt = { sha256: await fileHash(target) };
    }
    if ((await fileHash(target)) !== receipt.sha256) throw new Refusal('checkpoint_dump_changed');
    operation.receipts['checkpoint-dump'] = receipt;
    this.store.save(operation);
    await copyVerified(
      join(this.directory(), 'compose.json'),
      join(path, 'compose.json'),
      await fileHash(join(this.directory(), 'compose.json')),
    );
    await atomicJson(
      join(path, 'recovery.json'),
      Recovery.parse({
        schemaVersion: 2,
        installation: this.installation(),
        application: this.application(),
        dumpSha256: receipt.sha256,
        databasePassword: this.store.get('database-password'),
        mediaIncluded: false,
        databaseFormat: dump ? 'immich-source' : 'frameleaf-canonical',
      }),
    );
    return path;
  }
  control(kind: 'start' | 'stop' | 'restart' | 'backup', key: string, installationId?: string): Operation {
    const input = installationId ? { installationId } : {};
    if (installationId && this.installation()?.id !== installationId) throw new Refusal('installation_changed');
    const prior = this.store.request(kind, key, input);
    if (prior) return prior;
    const installation = this.installation();
    if (!installation) throw new Refusal('no_installation');
    const { operation, created } = this.store.start(kind, key, input);
    if (created) this.launch(operation, () => this.runControl(operation));
    return operation;
  }
  private async runControl(operation: Operation): Promise<void> {
    const installation = this.installation();
    if (!installation) throw new Refusal('no_installation');
    if (operation.input.installationId && operation.input.installationId !== installation.id) throw new Refusal('installation_changed');
    const kind = operation.kind;
    if (kind === 'backup') {
      await this.step(operation, 'database-backup', async () => {
        await this.backups.initialize();
        const checkpoint = await this.checkpoint(operation);
        return this.backups.snapshot(checkpoint, operation.id);
      });
    } else if (kind === 'start' || kind === 'stop' || kind === 'restart') {
      await this.step(operation, kind, () => this.composeAction(installation, kind));
    } else throw new Refusal('invalid_control_operation');
  }
  /**
   * FL-1263: the reviewed source must stay as reviewed until Frameleaf takes over the library (the installation may
   * have written media). After that the owner may change or remove the original app; callers still run
   * assertMedia, which refuses any other container that could write the media, the original app included.
   */
  private async verifySourceUntilTakeover(source: Source | SourceFence, installation?: Installation): Promise<void> {
    if (!this.installation()?.mayHaveWrittenMedia) await this.fencing.verify(source, installation);
  }
  /** Storage, source fencing and media ownership are rechecked before anything that can start containers. */
  private async composeAction(installation: Installation, kind: 'start' | 'stop' | 'restart'): Promise<boolean> {
    if (kind !== 'stop') await this.databaseStorage.verify(installation);
    if (kind !== 'stop' && installation.sourceId)
      await this.verifySourceUntilTakeover(this.store.get<Source>(`source:${installation.sourceId}`)!, installation);
    if (kind !== 'stop') await this.fencing.assertMedia(installation.mounts, installation);
    if (kind !== 'stop') await retuneDatabase(this.directory());
    // `restart` keeps a container's old command and shm_size; `up` recreates the database when they changed.
    if (kind === 'restart') await this.docker.compose(this.directory(), installation.project, 'up', ['database']);
    await this.docker.compose(this.directory(), installation.project, kind === 'start' ? 'up' : kind);
    return true;
  }
  /** The advanced container settings the installed stack was last rendered with. */
  containerSettings(): { services: ServiceOverrides } {
    if (!this.installation()) throw new Refusal('no_installation');
    return { services: this.application().services };
  }
  /**
   * Replaces the advanced container settings of the installed stack. The previous settings are journaled
   * before anything changes so a failed apply can be cancelled back to them; either way the stack is
   * brought up with `compose up`, which recreates only the containers whose definition changed.
   */
  reconfigure(services: ServiceOverrides, key: string): Operation {
    const installation = this.installation();
    if (!installation) throw new Refusal('no_installation');
    const input = { services };
    const prior = this.store.request('reconfigure', key, input);
    if (prior) return prior;
    checkServiceOverrides(installation.mounts.map(({ target }) => target), services, this.mountRoots());
    this.checkExternalFolders(services, [...installation.mounts.filter((m) => m.type === 'bind').map((m) => m.source), installation.databaseRoot]);
    const { operation, created } = this.store.start('reconfigure', key, input);
    if (created) this.launch(operation, () => this.applyReconfigure(operation));
    return operation;
  }
  /**
   * Host folders an advanced container setting may bind-mount: Manager's media and database roots (mapped
   * into Manager at identical paths) plus MANAGER_MOUNT_ROOTS, the administrator's explicit allow-list.
   */
  private adoptChosenBackupFolder(backups: string | undefined): void {
    if (!broadRoots(this.roots) || !backups) return;
    process.env.MANAGER_BACKUP_ROOT = backups;
    this.store.set('backup-root', backups);
    this.backups.relocate(join(backups, 'frameleaf-database'));
    this.mediaMove.backups = backups;
  }
  private checkExternalFolders(services: ServiceOverrides, used: string[], backups = process.env.MANAGER_BACKUP_ROOT!): void {
    if (!broadRoots(this.roots)) return;
    const occupied = [...used.filter(Boolean), backups, this.store.directory];
    for (const override of Object.values(services))
      for (const mount of override?.mounts ?? []) assertExternalFolder(mount.source, occupied);
  }
  private mountRoots(): string[] {
    return [
      ...this.roots,
      ...(this.databaseStorage?.roots ?? []),
      ...(process.env.MANAGER_MOUNT_ROOTS ?? '').split(':'),
    ].filter(Boolean);
  }
  private async renderServices(installation: Installation, services: ServiceOverrides): Promise<void> {
    checkServiceOverrides(installation.mounts.map(({ target }) => target), services, this.mountRoots());
    this.checkExternalFolders(services, [...installation.mounts.filter((m) => m.type === 'bind').map((m) => m.source), installation.databaseRoot]);
    const application = ApplicationConfig.parse({ ...this.application(), services });
    const release = await this.releases.acquire(installation.release);
    await renderCompose(release, installation, this.store.get<string>('database-password')!, this.directory(), application);
    this.store.set('application-config', application);
  }
  private async applyReconfigure(operation: Operation): Promise<void> {
    const installation = this.installation();
    if (!installation) throw new Refusal('no_installation');
    if (!operation.receipts['previous-container-settings']) {
      operation.receipts['previous-container-settings'] = this.application().services;
      this.store.save(operation);
    }
    await this.step(operation, 'apply-container-settings', async () => {
      await this.renderServices(installation, ServiceOverrides.parse(operation.input.services));
      return true;
    });
    await this.step(operation, 'start', () => this.composeAction(installation, 'start'));
  }
  async reviewUpdate(tag: string) {
    const current = this.installation();
    // ponytail: an older release is reached by restoring a recovery point taken on it (Backups), never as an update.
    if (!current || !isNewerRelease(tag, current.release)) throw new Refusal('select_a_new_release');
    // FL-1320: a missing photos or thumbnails drive is named before the update is offered, not after a stop.
    await assertMountSources(current.mounts);
    const compatibility = await this.docker.compatibility();
    const release = await this.releases.acquire(tag);
    const currentImage: string = JSON.parse(await readFile(join(this.directory(), 'compose.json'), 'utf8')).services.database.image;
    // The database image stays, changes in place when the signed bundle declares it for this major, or moves to a
    // new folder by dump and restore (FL-1265).
    const move = databaseImageMove(currentImage, release.nas);
    if (!move && !databaseImageChangeAllowed(currentImage, release.nas)) throw new Refusal('database_image_change_unsupported');
    const database = await this.targetDatabase();
    const postgres = JSON.parse(
      await this.docker.sql(
        database,
        `SELECT json_build_object('major',current_setting('server_version_num')::int / 10000,
      'extensions',(SELECT json_agg(json_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension));`,
      ),
    );
    const expectedMajor = postgresMajor(release.nas.images.postgres) ?? 19;
    if (move ? postgres.major > expectedMajor : postgres.major !== expectedMajor)
      throw new Refusal(expectedMajor === 19 ? 'canonical_postgres_19_required' : 'database_image_change_unsupported');
    if (!release.nas.platforms.includes(compatibility.platform)) throw new Refusal('release_architecture_unavailable');
    let databaseMove: UpdateReview['databaseMove'];
    if (move) {
      // The move allocates its new folder by the same estimate, measured again once the application stopped.
      const bytes = await this.databaseMoveBytes(database);
      await this.databaseStorage.validate(current.databaseRoot, bytes, current.id);
      databaseMove = { from: currentImage, to: release.nas.images.postgres, bytes };
    }
    const id = randomUUID();
    this.store.set(`update:${id}`, {
      id,
      expires: Date.now() + 900_000,
      current,
      release,
      platform: compatibility.platform,
      ...(databaseMove && { databaseMove }),
    });
    return {
      id,
      from: current.release,
      to: tag,
      backupScope: 'database-only',
      ...(databaseMove && {
        databaseMove: {
          from: postgresVersion(databaseMove.from) ?? `PostgreSQL ${postgresMajor(databaseMove.from)}`,
          to: postgresVersion(databaseMove.to) ?? `PostgreSQL ${postgresMajor(databaseMove.to)}`,
          bytes: databaseMove.bytes,
        },
      }),
      recovery: databaseMove
        ? 'A database checkpoint is created before updating. This release uses a new database engine, so Manager copies the database into a new folder beside the current one and checks it; the current folder is kept unchanged, and if anything fails Manager puts the previous release back on it. Media changes require separate recovery before returning to older software.'
        : 'A database checkpoint is created before updating. Media changes require separate recovery before returning to older software.',
    };
  }
  update(id: string, key: string): Operation {
    const prior = this.store.request('update', key, { reviewId: id });
    if (prior) return prior;
    const review = this.store.get<UpdateReview>(`update:${id}`);
    if (!review || review.expires < Date.now() || digest(review.current) !== digest(this.installation()))
      throw new Refusal('review_expired');
    const { operation, created } = this.store.start('update', key, { reviewId: id });
    if (created) this.launch(operation, () => this.applyUpdate(operation, review));
    return operation;
  }
  /**
   * Automatic updates (on unless the administrator turned them off): the same review and database checkpoint as
   * a manual update, one release step per check. Waits while any operation holds the lock (a failed or interrupted
   * one too), and stops after an update that failed, was rolled back or was cancelled until a later update the
   * administrator starts succeeds. A release that was rolled back is never chosen automatically again. A check
   * that could not start an update is kept as `auto-update-failure` for the dashboard.
   */
  async autoUpdate(): Promise<Operation | null> {
    if (this.store.get<boolean>('auto-update') === false) return null;
    const current = this.installation();
    if (!current || this.store.locked()) return null;
    // A rolled-back or cancelled update completes with its code as the error.
    const lastUpdate = this.store.history().find((o) => o.kind === 'update');
    if (lastUpdate && (lastUpdate.state !== 'complete' || lastUpdate.error)) return null;
    try {
      const rolledBack = new Set(this.store.get<string[]>('rolled-back-releases') ?? []);
      const [next] = (await this.releases.available())
        .map(({ tag }) => tag)
        .filter((tag) => isNewerRelease(tag, current.release) && !rolledBack.has(tag))
        .sort(compareReleases);
      if (!next) {
        this.store.delete('auto-update-failure');
        return null;
      }
      const { id } = await this.reviewUpdate(next);
      // The administrator may have turned automatic updates off while the release was being reviewed.
      if (this.store.get<boolean>('auto-update') === false) return null;
      const operation = this.update(id, randomUUID());
      this.store.delete('auto-update-failure');
      return operation;
    } catch (error) {
      this.store.set('auto-update-failure', {
        code: error instanceof Refusal ? error.code : 'operation_failed',
        at: new Date().toISOString(),
      });
      throw error;
    }
  }
  /**
   * Retry withdrawn targets with the next newer compatible release, retaining targets that may have started.
   * The administrator reviewed one release's notes: the retarget is the lowest newer release (never a jump
   * across several), and only while that review is still valid; afterwards a fresh review-update is required
   * (review L7).
   */
  private async retargetWithdrawnUpdate(operation: Operation, review: UpdateReview): Promise<UpdateReview> {
    // Older journals cannot prove a selected target never started.
    if (
      operation.completed.includes('apply-release') ||
      operation.receipts['rollback-intent'] ||
      (this.installation()?.release === review.release.nas.tag && operation.receipts['release-start-state'] !== 'prepared')
    )
      return review;
    const withdrawn = await this.releases.eligible(review.release.nas.tag).then(
      () => false,
      (error) => {
        if (error instanceof Refusal && error.code === 'release_not_eligible') return true;
        throw error;
      },
    );
    if (!withdrawn) return review;
    if (typeof review.expires === 'number' && review.expires < Date.now())
      throw new Refusal(
        'update_review_expired',
        409,
        `${review.release.nas.tag} was withdrawn after this update was reviewed and the review has expired. Cancel this update, then review the newer release before installing it.`,
      );
    // Same checks as reviewUpdate: the database image must be one this installation can take, and once a database
    // move began only a release with the image it moves to.
    const moving = operation.receipts['database-move-intent'] as DatabaseMoveIntent | undefined;
    const postgres = moving?.from.image ?? JSON.parse(await readFile(join(this.directory(), 'compose.json'), 'utf8')).services.database.image;
    const databaseAllowed = (nas: VerifiedRelease['nas']) =>
      moving ? nas.images.postgres === moving.to.image : databaseImageChangeAllowed(postgres, nas) || databaseImageMove(postgres, nas);
    let release: VerifiedRelease | undefined;
    const newer = (await this.releases.available())
      .map(({ tag }) => tag)
      .filter((tag) => isNewerRelease(tag, review.release.nas.tag))
      .sort(compareReleases);
    for (const tag of newer) {
      const candidate = await this.releases.acquire(tag);
      if (databaseAllowed(candidate.nas) && candidate.nas.platforms.includes(review.platform)) {
        release = candidate;
        break;
      }
    }
    if (!release) throw new Refusal('release_not_eligible');
    console.error(`manager: update target ${review.release.nas.tag} was withdrawn; retrying with the next release ${release.nas.tag}`);
    const retargeted = { ...review, release };
    this.store.set(`update:${operation.input.reviewId}`, retargeted);
    operation.completed = operation.completed.filter((step) => step !== 'download-images');
    this.store.save(operation);
    return retargeted;
  }
  /** Persist startup intent so retry cannot reuse a checkpoint after a different target may have written. */
  private async applyUpdate(operation: Operation, review: UpdateReview): Promise<void> {
    if (operation.receipts['rollback-intent']) return this.rollbackUpdate(operation, review);
    await this.step(operation, 'download-images', async () => {
      await this.releases.eligible(review.release.nas.tag);
      await this.releases.verify(review.release.directory, review.release.nas.tag);
      for (const image of await releaseImages(review.release.nas.images, review.current))
        await this.docker.pull(image, review.platform);
      return true;
    });
    await this.step(operation, 'stop-application', async () => {
      // Nothing is stopped while a media folder is missing: the new release could not start on it.
      await assertMountSources(review.current.mounts);
      const compose = JSON.parse(await readFile(join(this.directory(), 'compose.json'), 'utf8'));
      const mlService = compose.services['frameleaf-machine-learning']
        ? 'frameleaf-machine-learning'
        : 'immich-machine-learning';
      await this.docker.compose(this.directory(), review.current.project, 'stop', [
        'frameleaf-server',
        ...(review.current.ml ? [mlService] : []),
      ]);
      return true;
    });
    await this.step(operation, 'database-checkpoint', async () => {
      await this.backups.initialize();
      return this.backups.snapshot(await this.checkpoint(operation), operation.id);
    });
    // FL-1265: a database image that cannot reuse the data directory moves first. compose.json still names the
    // installed image here: only the move itself (which journals its intent first) re-renders it.
    const installed: string | undefined = JSON.parse(await readFile(join(this.directory(), 'compose.json'), 'utf8')).services
      .database?.image;
    if (operation.receipts['database-move-intent'] || (installed && databaseImageMove(installed, review.release.nas))) {
      try {
        await this.moveDatabase(operation, { current: review.current, release: review.release, databaseRoot: review.current.databaseRoot });
      } catch (error) {
        // Before its intent nothing changed but the application is stopped: the update is cancelled and the
        // previous release started again, so no retry reuses this checkpoint after the server wrote again.
        // After it, only the new folder was written: the previous release goes back on its unchanged folder.
        const reason = error instanceof Refusal ? error.code : ((error as Error)?.message ?? String(error));
        if (!operation.receipts['database-move-intent']) {
          console.error(redact(`manager: the database move to ${review.release.nas.images.postgres} did not start (${reason}); starting ${review.current.release} again`));
          operation.receipts['cancellation-intent'] = {
            kind: 'update',
            installation: this.installation(),
            archive: join(this.store.directory, `cancelled-stack-${operation.id}`),
          } satisfies Cancellation;
          this.store.save(operation);
          await this.cancelOperation(operation);
          operation.receipts['cancelled'] = 'database_move_failed_rolled_back';
          this.store.save(operation);
          return;
        }
        console.error(redact(`manager: the database did not move to ${review.release.nas.images.postgres} (${reason}); rolling back to ${review.current.release}`));
        operation.receipts['rollback-intent'] = error instanceof Refusal ? error.code : 'database_move_failed';
        this.store.save(operation);
        return this.rollbackUpdate(operation, review);
      }
    }
    try {
      await this.applyRelease(operation, review);
      const moved = operation.receipts['database-move'] as DatabaseMove | undefined;
      if (moved) {
        // The previous folder (and any interrupted attempt's) is no longer used; it is kept as it was.
        const retained = this.store.get<string[]>('retained-database-directories') ?? [];
        const unused = [moved.from.databasePath, ...moved.attempts.filter((path) => path !== moved.to.databasePath)];
        this.store.set('retained-database-directories', [...new Set([...retained, ...unused])]);
      }
    } catch (error) {
      // Issue 863: a target that started but never turned healthy boot-loops. Before 'starting' nothing ran,
      // and the operation stays cancellable back to the previous release instead.
      if (operation.receipts['release-start-state'] !== 'starting') throw error;
      // Another service (machine learning) can fail `up --wait` after the server served and took writes.
      // FL-1210: the server's own marker adds a request served after Docker's bounded health log lost the
      // probe; a healthy server is still kept, since its background jobs may have written before any request.
      if (
        (await this.markerServed(operation)) ||
        operation.receipts['server-served'] ||
        (await this.serverMayHaveServed(review).catch(() => true))
      ) {
        operation.receipts['release-start-state'] = 'started';
        this.store.save(operation);
        throw error;
      }
      const reason = error instanceof Refusal ? error.code : ((error as Error)?.message ?? String(error));
      console.error(redact(`manager: ${review.release.nas.tag} did not start (${reason}); rolling back to ${review.current.release}`));
      operation.receipts['rollback-intent'] = error instanceof Refusal ? error.code : 'release_start_failed';
      this.store.save(operation);
      await this.rollbackUpdate(operation, review);
    }
  }
  private async applyRelease(operation: Operation, review: UpdateReview): Promise<void> {
    await this.step(operation, 'apply-release', async () => {
      // FL-1265: after a database move the release runs on the moved folder.
      const moved = operation.completed.includes('database-move')
        ? (operation.receipts['database-move'] as DatabaseMove)
        : undefined;
      const installation = {
        ...review.current,
        release: review.release.nas.tag,
        ...(moved && { databasePath: moved.to.databasePath }),
      };
      await this.databaseStorage.verify(installation);
      await this.releases.eligible(review.release.nas.tag);
      this.store.set('previous-installation', review.current);
      const source = installation.sourceId ? this.store.get<Source>(`source:${installation.sourceId}`) : null;
      if (source) await this.verifySourceUntilTakeover(source, installation);
      await this.fencing.assertMedia(installation.mounts, installation);
      // A PostgreSQL image that cannot reuse the data directory was moved above (compose.json names the new image
      // by now); otherwise the signed bundle declares this exact same-major transition in place, with the
      // checkpoint above as its fallback.
      const oldCompose = JSON.parse(await readFile(join(this.directory(), 'compose.json'), 'utf8'));
      const previousImage: string = oldCompose.services.database.image;
      if (!databaseImageChangeAllowed(previousImage, review.release.nas))
        throw new Refusal('database_image_change_unsupported');
      if (previousImage !== review.release.nas.images.postgres) {
        if (!operation.completed.includes('database-checkpoint')) throw new Refusal('database_checkpoint_required');
        operation.receipts['database-image-change'] = { from: previousImage, to: review.release.nas.images.postgres };
        console.error(`manager: ${review.release.nas.tag} replaces the database image in place (${previousImage} -> ${review.release.nas.images.postgres}); checkpoint ${String(operation.receipts['database-checkpoint'])} precedes it`);
      }
      if (
        operation.receipts['release-start-state'] === undefined &&
        this.installation()?.release === review.current.release
      ) {
        operation.receipts['release-start-state'] = 'prepared';
        this.store.save(operation);
      }
      await renderCompose(
        review.release,
        installation,
        this.store.get<string>('database-password')!,
        this.directory(),
        this.application(),
      );
      this.store.set('installation', installation);
      // Once the target was healthy it may have accepted writes: a later failure never restores the checkpoint.
      if (operation.receipts['release-start-state'] !== 'started') {
        operation.receipts['release-start-state'] = 'starting';
        operation.receipts['release-started-at'] ??= new Date().toISOString();
        this.store.save(operation); // Persist intent before the target can write.
      }
      await this.watchServer(operation, review, () => this.docker.compose(this.directory(), installation.project, 'up'));
      operation.receipts['release-start-state'] = 'started';
      this.store.save(operation);
      return this.libraryStatus();
    });
  }
  /**
   * FL-1265: moves the database to the release's PostgreSQL image when that image cannot open the current data
   * directory (a beta, RC or major change). With the application stopped, the checkpoint dump is restored into a
   * new folder beside the current one under the new image and compared with the stopped original (row counts of
   * every table, extensions, server version). apply-release then starts the release on the new folder. The
   * original folder is never written again, so a rollback or cancel puts the previous release back on it.
   * FL-1322: a drive move runs the same step on the installed release and image, into `move.databaseRoot`.
   */
  private async moveDatabase(operation: Operation, move: DatabaseMoveTarget): Promise<DatabaseMove> {
    return this.step(operation, 'database-move', async () => {
      const dump = join(this.store.directory, 'checkpoints', operation.id, 'database.dump');
      const receipt = operation.receipts['checkpoint-dump'] as { sha256: string } | undefined;
      if (!receipt || (await fileHash(dump)) !== receipt.sha256) throw new Refusal('checkpoint_dump_changed');
      let intent = operation.receipts['database-move-intent'] as DatabaseMoveIntent | undefined;
      if (!intent) {
        const source = await this.targetDatabase(move.current);
        intent = {
          from: {
            image: JSON.parse(await readFile(join(this.directory(), 'compose.json'), 'utf8')).services.database.image,
            databasePath: move.current.databasePath,
          },
          to: { image: move.release.nas.images.postgres },
          // The application stopped before the checkpoint, so the running database still matches its dump.
          source: await this.databaseInventory(source),
          bytes: await this.databaseMoveBytes(source),
          attempts: [],
        };
        operation.receipts['database-move-intent'] = intent;
        // Cancel renders the previous release's stack again before starting anything.
        if (operation.receipts['release-start-state'] === undefined) operation.receipts['release-start-state'] = 'prepared';
        this.store.save(operation);
      }
      if (intent.to.image !== move.release.nas.images.postgres) throw new Refusal('database_move_target_changed');
      // Every attempt restores into a folder of its own: an interrupted one may have left a partial restore.
      const databasePath = await this.databaseStorage.allocate(move.databaseRoot, move.current.id, intent.bytes);
      intent.attempts.push(databasePath);
      this.store.save(operation);
      const target: Installation = { ...move.current, release: move.release.nas.tag, databaseRoot: move.databaseRoot, databasePath };
      await this.docker.compose(this.directory(), move.current.project, 'stop');
      await renderCompose(move.release, target, this.store.get<string>('database-password')!, this.directory(), this.application());
      await this.docker.compose(this.directory(), target.project, 'up', ['database']);
      const database = await this.targetDatabase(target);
      await this.docker.verifyDump(database, dump);
      await this.docker.restore(database, dump);
      const moved = await this.databaseInventory(database);
      const version = postgresVersion(intent.to.image);
      if (version ? moved.version !== version : Number.parseInt(moved.version, 10) !== postgresMajor(intent.to.image))
        throw new Refusal('database_move_version_mismatch', 409, `Expected ${version ?? intent.to.image}, found ${moved.version}.`);
      if (!sameInventory(moved, intent.source)) throw new Refusal('database_move_verification_failed');
      return { ...intent, to: { image: intent.to.image, databaseRoot: move.databaseRoot, databasePath } } satisfies DatabaseMove;
    });
  }
  /** FL-1265: room a database move needs for the restored copy, checked at review and allocated by the move. */
  private async databaseMoveBytes(database: Database): Promise<number> {
    return Math.max(1024 ** 3, Number(await this.docker.sql(database, 'SELECT pg_database_size(current_database());')));
  }
  private async databaseInventory(database: Database): Promise<DatabaseInventory> {
    // Counting every table of a large library can outlast the default 2 minutes; same budget as dump and restore.
    return JSON.parse(await this.docker.sql(database, DATABASE_INVENTORY, 7_200_000));
  }
  /**
   * FL-1322: review moving the installed database to another folder, usually on another drive. The folder must
   * pass the same checks as a new install's database folder (a host bind on a local disk, outside Docker's
   * storage, no other container writing there) and hold the database twice: the moved copy, and later the second
   * copy an engine upgrade restores beside it.
   */
  async reviewDatabaseMove(databaseRoot: string) {
    const current = this.installation();
    if (!current) throw new Refusal('no_installation');
    if (this.store.locked()) throw new Refusal('operation_in_progress');
    if (databaseRoot === current.databaseRoot) throw new Refusal('database_already_in_folder');
    const binds = current.mounts.filter((m) => m.type === 'bind').map((m) => m.source);
    const retained = this.store.get<string[]>('retained-database-directories') ?? [];
    // Apart from the media, backups, Manager's own folder and the database in use. A retained database folder only
    // blocks a root inside it: a retry into the same root, or a move back to the original one, keeps it beside.
    for (const other of [current.databasePath, ...binds, process.env.MANAGER_BACKUP_ROOT, this.store.directory])
      if (other && overlaps(databaseRoot, other)) throw new Refusal('chosen_folders_overlap');
    if (retained.some((folder) => inside(databaseRoot, folder))) throw new Refusal('chosen_folders_overlap');
    this.checkExternalFolders(this.application().services ?? {}, [...binds, databaseRoot]);
    if (broadRoots(this.roots)) await ensureChosenFolder(databaseRoot);
    const release = await this.releases.acquire(current.release);
    const image: string = JSON.parse(await readFile(join(this.directory(), 'compose.json'), 'utf8')).services.database.image;
    // The move keeps the engine: an installed image the release no longer names is an update's job.
    if (image !== release.nas.images.postgres) throw new Refusal('database_image_changed');
    const bytes = await this.databaseMoveBytes(await this.targetDatabase(current));
    const requiredBytes = 2 * bytes;
    const { filesystem } = await this.databaseStorage.validate(databaseRoot, requiredBytes, current.id);
    const space = await statfs(databaseRoot);
    const id = randomUUID();
    this.store.set(`database-move:${id}`, {
      id,
      expires: Date.now() + 900_000,
      current,
      release,
      databaseRoot,
      bytes,
    } satisfies DatabaseRelocationReview);
    return {
      id,
      from: current.databaseRoot,
      to: databaseRoot,
      filesystem,
      databaseBytes: bytes,
      requiredBytes,
      availableBytes: space.bavail * space.bsize,
      recovery:
        'Frameleaf stops while Manager creates a database recovery point, copies the database into a new folder on the chosen drive and checks every table. If anything goes wrong before Frameleaf starts on the new folder, Manager starts Frameleaf again on the current folder. Once Frameleaf has started on the new folder, it stays there, because new changes may already be saved there: if it does not start properly, choose Resume to try again. The current folder is kept until you remove it.',
    };
  }
  moveDatabaseTo(id: string, key: string): Operation {
    const prior = this.store.request('move-database', key, { reviewId: id });
    if (prior) return prior;
    const review = this.store.get<DatabaseRelocationReview>(`database-move:${id}`);
    if (!review || review.expires < Date.now() || digest(review.current) !== digest(this.installation()))
      throw new Refusal('review_expired');
    const { operation, created } = this.store.start('move-database', key, { reviewId: id });
    if (created) this.launch(operation, () => this.applyDatabaseRelocation(operation, review));
    return operation;
  }
  /**
   * FL-1322: stop the application, checkpoint, restore into a new folder in the chosen root and compare it
   * (moveDatabase), then start the application on it. Until the application is started on the new folder,
   * any failure puts the original stack back on the original folder, which nothing wrote since the stop.
   * `start-state` is the barrier: journaled before the server first starts on the new folder, after which the new
   * database may have taken writes and is kept, whatever happens next.
   */
  private async applyDatabaseRelocation(operation: Operation, review: DatabaseRelocationReview): Promise<void> {
    if (operation.receipts['rollback-intent']) return this.returnToOriginalDatabase(operation, review, 'database_relocation_rolled_back');
    const fail = async (error: unknown, fallback: string) => {
      const reason = error instanceof Refusal ? error.code : ((error as Error)?.message ?? String(error));
      console.error(redact(`manager: the database did not move to ${review.databaseRoot} (${reason}); starting again on ${review.current.databasePath}`));
      operation.receipts['rollback-intent'] = error instanceof Refusal ? error.code : fallback;
      this.store.save(operation);
      return this.returnToOriginalDatabase(operation, review, 'database_relocation_rolled_back');
    };
    let moved: DatabaseMove;
    try {
      await this.step(operation, 'stop-application', async () => {
        await this.docker.compose(this.directory(), review.current.project, 'stop', [
          'frameleaf-server',
          ...(review.current.ml ? [await this.mlService()] : []),
        ]);
        return true;
      });
      await this.step(operation, 'database-checkpoint', async () => {
        await this.backups.initialize();
        return this.backups.snapshot(await this.checkpoint(operation), operation.id);
      });
      const image: string = JSON.parse(await readFile(join(this.directory(), 'compose.json'), 'utf8')).services.database.image;
      if (!operation.receipts['database-move-intent'] && image !== review.release.nas.images.postgres)
        throw new Refusal('database_image_changed');
      moved = await this.moveDatabase(operation, review);
    } catch (error) {
      return fail(error, 'database_move_failed');
    }
    const installation: Installation = { ...review.current, databaseRoot: review.databaseRoot, databasePath: moved.to.databasePath };
    try {
      await this.step(operation, 'start', async () => {
        await this.databaseStorage.verify(installation);
        await this.fencing.assertMedia(installation.mounts, installation);
        if (!operation.receipts['start-state']) {
          operation.receipts['start-state'] = 'starting';
          this.store.save(operation); // Journaled before the server can write to the new folder.
        }
        this.store.set('installation', installation);
        await this.docker.compose(this.directory(), installation.project, 'up');
        return this.libraryStatus();
      });
    } catch (error) {
      // Past the barrier the server may have written to the new folder, even if it has stopped since: the new
      // folder is kept and the operation fails, so nothing those writes changed is ever rolled back.
      if (operation.receipts['start-state']) throw error;
      return fail(error, 'database_move_start_failed');
    }
    // The original folder (and any interrupted attempt's) is kept as it was until the administrator removes it.
    const retained = this.store.get<string[]>('retained-database-directories') ?? [];
    const unused = [review.current.databasePath, ...moved.attempts.filter((path) => path !== moved.to.databasePath)];
    this.store.set('retained-database-directories', [...new Set([...retained, ...unused])]);
  }
  private async mlService(): Promise<string> {
    const compose = JSON.parse(await readFile(join(this.directory(), 'compose.json'), 'utf8'));
    return compose.services['frameleaf-machine-learning'] ? 'frameleaf-machine-learning' : 'immich-machine-learning';
  }
  /**
   * Put the stack from before a drive move back: the checkpoint's compose.json (the original folder, which was
   * never written after the stop), the original installation record, and start it. Attempt folders are retained.
   */
  private async returnToOriginalDatabase(operation: Operation, review: DatabaseRelocationReview, code: string): Promise<void> {
    const previous = review.current;
    const move = operation.receipts['database-move-intent'] as DatabaseMoveIntent | undefined;
    await this.step(operation, 'return-original-database', async () => {
      if (move) {
        await this.docker.compose(this.directory(), previous.project, 'stop');
        const compose = JSON.parse(await readFile(join(this.store.directory, 'checkpoints', operation.id, 'compose.json'), 'utf8'));
        const data = compose.services.database.volumes.find((v: any) => v.target === '/var/lib/postgresql');
        if (data?.source !== previous.databasePath.replaceAll('$', () => '$$') || compose.services.database.image !== move.from.image)
          throw new Refusal('database_path_changed');
        const retained = this.store.get<string[]>('retained-database-directories') ?? [];
        this.store.set('retained-database-directories', [...new Set([...retained, ...move.attempts])]);
        await atomicJson(join(this.directory(), 'compose.json'), compose);
      }
      this.store.set('installation', previous);
      return true;
    });
    await this.step(operation, 'start-original-database', async () => {
      await this.databaseStorage.verify(previous);
      await this.fencing.assertMedia(previous.mounts, previous);
      await this.docker.compose(this.directory(), previous.project, 'up');
      return true;
    });
    operation.receipts['cancelled'] = code;
  }
  /** FL-1322: database folders a move, update or restore left behind, for the administrator to remove. */
  async retainedDatabases(): Promise<{ path: string; present: boolean }[]> {
    return Promise.all(
      (this.store.get<string[]>('retained-database-directories') ?? []).map(async (path) => ({
        path,
        present: await lstat(path).then(
          (s) => s.isDirectory(),
          () => false,
        ),
      })),
    );
  }
  /**
   * FL-1322: delete a retained database folder once the library runs on another one. Only a folder Manager
   * retained, never the one in use or one any container maps, and only while no operation is open and the
   * current database answers.
   */
  async removeRetainedDatabase(path: string): Promise<void> {
    const retained = this.store.get<string[]>('retained-database-directories') ?? [];
    if (!retained.includes(path)) throw new Refusal('database_folder_not_retained');
    if (this.store.locked()) throw new Refusal('operation_in_progress');
    const installation = this.installation();
    if (!installation) throw new Refusal('no_installation');
    // inside() also matches the same files through another Unraid share view (/mnt/user and /mnt/diskN).
    if (inside(installation.databasePath, path) || inside(path, installation.databasePath))
      throw new Refusal('database_folder_in_use');
    if (!/^frameleaf-[a-f0-9]{12}-postgres-[A-Za-z0-9]+$/.test(basename(path)) || !isAbsolute(path))
      throw new Refusal('invalid_database_directory');
    // Any container (running or stopped: it can start later) that maps this folder, something inside it, or a folder
    // above it may use these files. Manager's own containers map the database parent and never use PGDATA; this
    // library's stack maps only its media and the database in use (checked above), so only its mappings of this
    // folder or inside it count. Each side is compared as reported, as the host and Manager name it, Manager's view
    // with links resolved, and the host's own resolution, which follows links outside Manager's mappings. A path
    // the host can't resolve could lead anywhere, so the folder is kept rather than compared by its spelling.
    const containers = (await this.docker.inventory()).filter((c) => c.Config.Labels?.['app.frameleaf.manager.role'] !== 'controller');
    const sources = [...new Set(containers.flatMap((c) => c.Mounts.map((m) => m.Source).filter((source) => source?.startsWith('/'))))];
    const resolved = await this.hostRealpaths([path, ...sources]);
    const unresolved = resolved && containers.find((c) => c.Mounts.some((m) => resolved[sources.indexOf(m.Source) + 1] === null));
    if (!resolved || resolved[0] === null || unresolved)
      throw new Refusal(
        'database_folder_unverified',
        409,
        unresolved ? `Manager could not tell where a folder container ${unresolved.Name.replace(/^\//, '')} maps really is.` : undefined,
      );
    const onHost = new Map(sources.map((source, i) => [source, resolved[i + 1]!]));
    const spellings = async (value: string, host: string) => [
      ...new Set([value, toHost(value), toContainer(value), host, ...(await Promise.all([value, toContainer(value)].map((v) => realpath(v).catch(() => v))))]),
    ];
    const names = await spellings(path, resolved[0]);
    let user: (typeof containers)[number] | undefined;
    for (const c of containers) {
      const own = c.Config.Labels?.['app.frameleaf.manager'] === installation.id;
      for (const m of c.Mounts)
        if (m.Source?.startsWith('/'))
          for (const source of await spellings(m.Source, onHost.get(m.Source)!))
            if (names.some((f) => inside(source, f) || (!own && inside(f, source)))) user ??= c;
    }
    if (user) throw new Refusal('database_folder_in_use', 409, `Container ${user.Name.replace(/^\//, '')} maps this folder.`);
    await this.docker.sql(await this.targetDatabase(installation), 'SELECT 1;').catch(() => {
      throw new Refusal('database_unconfirmed');
    });
    const folder = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (folder) {
      if (!folder.isDirectory() || folder.isSymbolicLink() || (await realpath(path)) !== path)
        throw new Refusal('database_path_changed');
      await rm(path, { recursive: true });
    }
    const now = this.store.get<string[]>('retained-database-directories') ?? [];
    this.store.set('retained-database-directories', now.filter((other) => other !== path));
  }
  /**
   * FL-1210: whether the server's `frameleaf-served` marker (written on each boot's first real request)
   * shows the target served since this update started it. Unreadable, missing or older is false here, so
   * the caller's Docker health evidence decides.
   */
  private async markerServed(operation: Operation): Promise<boolean> {
    const since = Date.parse(String(operation.receipts['release-started-at']));
    if (Number.isNaN(since)) return false;
    const servedAt = await this.targetDatabase()
      .then((database) =>
        this.docker.sql(
          database,
          `SELECT coalesce((SELECT value->>'servedAt' FROM public.system_metadata WHERE key='frameleaf-served'), '');`,
        ),
      )
      .then((value) => Date.parse(value.trim()))
      .catch(() => Number.NaN);
    return servedAt >= since;
  }
  /**
   * Poll the new server while it starts and journal `server-served` the first time Docker shows it passing
   * a health probe; the `frameleaf-served` marker covers a request served after the probe ages out. Docker keeps only its
   * last five probes, so the final log alone cannot prove the server never served. ponytail: polled every
   * serverWatchMs, which must stay under five probe intervals.
   */
  private async watchServer(operation: Operation, review: UpdateReview, start: () => Promise<void>): Promise<void> {
    const check = async () => {
      if (operation.receipts['server-served'] || !(await this.serverMayHaveServed(review).catch(() => false))) return;
      operation.receipts['server-served'] = true;
      try {
        this.store.save(operation);
      } catch (error) {
        delete operation.receipts['server-served']; // Not journaled: the next poll retries.
        throw error;
      }
    };
    const logged = () =>
      check().catch((error) =>
        console.error(redact(`manager: could not journal the new server's health (${(error as Error)?.message ?? error})`)),
      );
    // One poll at a time; the one in flight when the interval stops is awaited, so a `server-served` it records
    // is journaled before the caller decides between keeping the target and rolling back.
    let polling: Promise<void> | undefined;
    const timer = setInterval(() => {
      polling ??= logged().finally(() => (polling = undefined));
    }, this.serverWatchMs);
    timer.unref();
    try {
      await start();
    } catch (error) {
      // The start's own failure is what the caller reports; the caller re-checks Docker before any rollback.
      clearInterval(timer);
      await polling;
      await logged();
      throw error;
    }
    clearInterval(timer);
    await polling;
    await check();
  }
  /** Whether Docker shows the target's server passing a health probe in its (bounded) health log. */
  private async serverMayHaveServed(review: UpdateReview): Promise<boolean> {
    const server = (await this.docker.inventory()).find(
      (c) =>
        c.Config.Labels?.['app.frameleaf.manager'] === review.current.id &&
        c.Config.Labels?.['com.docker.compose.service'] === 'frameleaf-server',
    );
    // No container of the target's image means the target server never ran.
    if (!server || server.Config.Image !== review.release.nas.images.server) return false;
    const health = server.State.Health;
    if (!health) return server.State.Running;
    return health.Status === 'healthy' || !!health.Log?.some((probe) => probe.ExitCode === 0);
  }
  /**
   * Put the previous release back after its replacement started and failed. The target may have migrated
   * the database, so its directory is retained and the pre-update checkpoint is restored into a new empty
   * one; the stack is the previous release's compose.json from that checkpoint, pointed at the new directory.
   * FL-1265: after a database move (or a failed one) the previous folder was never written again, so the
   * previous release's compose.json goes back unchanged, on its own image and folder, without a restore.
   */
  private async rollbackUpdate(operation: Operation, review: UpdateReview): Promise<void> {
    const previous = review.current;
    const checkpoint = join(this.store.directory, 'checkpoints', operation.id);
    // renderCompose stores every string with `$` doubled for Compose interpolation.
    const escaped = (path: string) => path.replaceAll('$', () => '$$');
    const move = operation.receipts['database-move-intent'] as DatabaseMoveIntent | undefined;
    await this.step(operation, 'rollback-stop-release', async () => {
      await this.docker.compose(this.directory(), previous.project, 'stop');
      return true;
    });
    if (move)
      await this.step(operation, 'rollback-previous-database', async () => {
        const compose = JSON.parse(await readFile(join(checkpoint, 'compose.json'), 'utf8'));
        const data = compose.services.database.volumes.find((v: any) => v.target === '/var/lib/postgresql');
        if (data?.source !== escaped(previous.databasePath) || compose.services.database.image !== move.from.image)
          throw new Refusal('database_path_changed');
        const retired = this.store.get<string[]>('retained-database-directories') ?? [];
        this.store.set('retained-database-directories', [...new Set([...retired, ...move.attempts])]);
        await atomicJson(join(this.directory(), 'compose.json'), compose);
        this.store.set('installation', previous);
        return true;
      });
    const restored: Installation = move ? previous : await this.step(operation, 'rollback-restore-database', async () => {
      const dump = join(checkpoint, 'database.dump');
      const receipt = operation.receipts['checkpoint-dump'] as { sha256: string } | undefined;
      if (!receipt || (await fileHash(dump)) !== receipt.sha256) throw new Refusal('checkpoint_dump_changed');
      // A rerun of this step retains the half-restored directory of the attempt before it, too.
      const retired = this.store.get<string[]>('retained-database-directories') ?? [];
      const current = this.installation()?.databasePath ?? previous.databasePath;
      this.store.set('retained-database-directories', [...new Set([...retired, current])]);
      const databaseBytes = Math.max(1024 ** 3, (await stat(dump)).size * 4);
      const installation: Installation = {
        ...previous,
        databasePath: await this.databaseStorage.allocate(previous.databaseRoot, previous.id, databaseBytes),
      };
      const compose = JSON.parse(await readFile(join(checkpoint, 'compose.json'), 'utf8'));
      const data = compose.services.database.volumes.find((v: any) => v.target === '/var/lib/postgresql');
      if (data?.source !== escaped(previous.databasePath)) throw new Refusal('database_path_changed');
      data.source = escaped(installation.databasePath);
      await atomicJson(join(this.directory(), 'compose.json'), compose);
      this.store.set('installation', installation);
      await this.docker.compose(this.directory(), installation.project, 'up', ['database']);
      const database = await this.targetDatabase();
      await this.docker.verifyDump(database, dump);
      await this.docker.restore(database, dump);
      return installation;
    });
    await this.step(operation, 'rollback-start-previous', async () => {
      await this.fencing.assertMedia(restored.mounts, restored);
      await this.docker.compose(this.directory(), restored.project, 'up');
      return true;
    });
    // Automatic updates never choose this release again; the administrator can still review it by hand.
    const rolledBack = this.store.get<string[]>('rolled-back-releases') ?? [];
    this.store.set('rolled-back-releases', [...new Set([...rolledBack, review.release.nas.tag])]);
    operation.receipts['cancelled'] =
      move && !operation.completed.includes('database-move') ? 'database_move_failed_rolled_back' : 'update_failed_rolled_back';
  }
  /**
   * `thumbnailFallback`: the administrator accepted keeping thumbnails in the library's own `thumbs` folder
   * because the thumbnail folder is gone (FL-1320). Without it a missing thumbnail folder is refused by name.
   */
  async reviewRestore(snapshot: string, databaseRoot: string, managerPort?: number, thumbnailFallback = false) {
    const current = this.installation();
    const id = randomUUID(),
      checkpoint = join(this.store.directory, `restore-${id}`);
    await this.backups.restore(snapshot, checkpoint);
    const recovery = Recovery.parse(JSON.parse(await readFile(join(checkpoint, 'recovery.json'), 'utf8')));
    if (recovery.databaseFormat !== 'frameleaf-canonical')
      throw new Refusal('immich_source_checkpoint_requires_source_recovery');
    // FL-1320: thumbnails can move to another drive after a backup; that does not make it another library.
    if (
      current &&
      ((current.libraryId ?? current.id) !== (recovery.installation.libraryId ?? recovery.installation.id) ||
        digest(libraryMounts(current.mounts)) !== digest(libraryMounts(recovery.installation.mounts)))
    )
      throw new Refusal('backup_belongs_to_another_library');
    // FL-1320: thumbnails stay where they are now, the current installation's folder, else the backup's. A missing
    // thumbnail folder is a check result (FL-1317); the administrator may keep thumbnails in the photos folder instead.
    const thumbnails = thumbnailMount(current ? current.mounts : recovery.installation.mounts);
    const folder = thumbnailFolder(libraryMounts(recovery.installation.mounts));
    const thumbnailsMissing = !!thumbnails && !(await folderExists(thumbnails.source));
    const fallback: RestoreReview['thumbnailFallback'] =
      thumbnailsMissing && thumbnailFallback && folder ? { missing: thumbnails!.source, folder } : undefined;
    const mounts = withThumbnails(recovery.installation.mounts, thumbnailsMissing ? null : (thumbnails?.source ?? null));
    const hash = await fileHash(join(checkpoint, 'database.dump'));
    if (hash !== recovery.dumpSha256) throw new Refusal('restore_checkpoint_changed');
    const databaseBytes = Math.max(1024 ** 3, (await stat(join(checkpoint, 'database.dump'))).size * 4);
    // FL-1317: the server checks, reported together. The backup itself was checked above.
    const checks = await this.restoreChecks(
      { mounts, port: recovery.installation.port, ml: recovery.installation.ml }, databaseRoot, databaseBytes, current, managerPort, 'review',
      thumbnailsMissing && !fallback ? { missing: thumbnails!.source, folder } : undefined,
    );
    const { compatibility, databaseStorage } = checks;
    const release = !checks.blocked && compatibility
      ? await checks.run('release', async () => {
          const value = await this.releases.acquire(recovery.installation.release);
          if (!value.nas.platforms.includes(compatibility!.platform)) {
            await rm(value.directory, { recursive: true, force: true });
            throw new Refusal('release_architecture_unavailable', 409, compatibility!.platform);
          }
          return { value, outcome: { facts: { tag: value.nas.tag } } };
        })
      : undefined;
    await this.hostNotes(checks, compatibility?.memory, recovery.installation.ml);
    const host = this.checkHost();
    if (!release || !databaseStorage || checks.blocked) {
      await rm(checkpoint, { recursive: true, force: true });
      return { ready: false as const, host, port: recovery.installation.port, checks: checks.results };
    }
    this.store.set(`restore:${id}`, {
      id,
      expires: Date.now() + 900_000,
      snapshot,
      checkpoint,
      hash,
      databaseRoot,
      databaseBytes,
      release,
      recovery,
      platform: compatibility!.platform,
      current,
      mounts,
      ...(fallback && { thumbnailFallback: fallback }),
    } satisfies RestoreReview);
    return {
      ready: true as const,
      host,
      checks: checks.results,
      id,
      release: release.nas.tag,
      mounts,
      thumbnailFallback: fallback ?? null,
      port: recovery.installation.port,
      databaseStorage,
      mediaIncluded: false,
      replacesInstallation: !!current,
    };
  }
  /** The restore review's server checks; the restore repeats them before it downloads anything. */
  private async restoreChecks(
    target: { mounts: Mount[]; port: number; ml: boolean },
    databaseRoot: string,
    databaseBytes: number,
    current: Installation | null,
    managerPort: number | undefined,
    phase: 'review' | 'start',
    /** FL-1320: the thumbnail folder is gone; `folder` is the photos folder's own `thumbs`, when there is one. */
    thumbnailsMissing?: { missing: string; folder: string | null },
  ) {
    const checks = new ServerCheck();
    const broad = broadRoots(this.roots);
    const binds = target.mounts.filter((m) => m.type === 'bind').map((m) => m.source);
    const compatibility = await checks.run('docker', async () => {
      const value = await this.docker.compatibility();
      return { value, outcome: { facts: { version: value.version ?? null } } };
    });
    await this.roomCheck(checks, target.ml);
    if (thumbnailsMissing) {
      await checks.run('thumbnails', async () => {
        throw new Refusal('thumbnail_folder_missing', 409, thumbnailsMissing.missing);
      });
      checks.annotate('thumbnails', { missing: thumbnailsMissing.missing, folder: thumbnailsMissing.folder });
    }
    await checks.run('media', async () => {
      // A drive that isn't mounted is named plainly (media_folder_missing) before any other folder check.
      await assertMountSources(target.mounts);
      await this.fencing.assertMedia(target.mounts, current ?? undefined);
      const containers = await this.docker.inventory();
      for (const mount of target.mounts) {
        if (mount.type === 'bind') await storagePath(mount.source, this.roots, 0);
        else if (!containers.some((c) => c.Mounts.some((m) => m.Type === 'volume' && m.Name === mount.source)))
          throw new Refusal('external_media_volume_unavailable', 409, mount.source);
        if (/^\/(?:proc|sys|dev|etc|run|var\/run)(?:\/|$)/.test(mount.target) || mount.target.includes('..'))
          throw new Refusal('unsafe_recovery_mount', 409, mount.target);
      }
      return { outcome: { facts: { folders: target.mounts.length } } };
    });
    const databaseStorage = await checks.run('database', async () => {
      if (broad) {
        for (const other of [process.env.MANAGER_BACKUP_ROOT!, this.store.directory, ...binds])
          assertSeparateFolders([databaseRoot, other]);
        if (phase === 'review') await ensureChosenFolder(databaseRoot);
      }
      const value = await this.databaseStorage.validate(databaseRoot, databaseBytes);
      return { value, outcome: { facts: { path: databaseRoot, free: await freeBytes(databaseRoot) } } };
    });
    await this.portCheck(checks, target.port, current, undefined, managerPort, false);
    await this.downloadsCheck(checks);
    return Object.assign(checks, { compatibility, databaseStorage });
  }
  restore(id: string, key: string): Operation {
    const prior = this.store.request('restore', key, { reviewId: id });
    if (prior) return prior;
    const review = this.store.get<RestoreReview>(`restore:${id}`);
    if (!review || review.expires < Date.now() || digest(review.current) !== digest(this.installation()))
      throw new Refusal('review_expired');
    const { operation, created } = this.store.start('restore', key, { reviewId: id });
    if (created) this.launch(operation, () => this.applyRestore(operation, review));
    return operation;
  }
  private async applyRestore(operation: Operation, review: RestoreReview): Promise<void> {
    await this.step(operation, 'download-images', async () => {
      // FL-1317: the review's checks again, so a change since the review still refuses before any download.
      (await this.restoreChecks(
        { mounts: review.mounts ?? review.recovery.installation.mounts, port: review.recovery.installation.port, ml: review.recovery.installation.ml },
        review.databaseRoot, review.databaseBytes, review.current, undefined, 'start',
      )).assert();
      await this.releases.eligible(review.release.nas.tag);
      await this.releases.verify(review.release.directory, review.release.nas.tag);
      for (const image of await releaseImages(review.release.nas.images, review.recovery.installation))
        await this.docker.pull(image, review.platform);
      return true;
    });
    if (review.current) {
      await this.step(operation, 'stop-previous-installation', async () => {
        if (digest(this.installation()) !== digest(review.current)) throw new Refusal('installation_changed');
        this.store.createOnce(`previous-installation:${operation.id}`, {
          installation: review.current!,
          password: this.store.get<string>('database-password')!,
          application: this.application(),
          onboardingFinished: this.store.get('onboarding-finished'),
          archive: join(this.store.directory, `previous-stack-${operation.id}`),
        } satisfies PreviousInstallation);
        await this.fencing.stopInstallation(review.current!);
        return true;
      });
      await this.fencing.verifyInstallation(review.current);
      await this.step(operation, 'archive-previous-installation', async () => {
        const previous = this.store.get<PreviousInstallation>(`previous-installation:${operation.id}`)!;
        await this.archiveStack(previous.archive);
        const retained = this.store.get<string[]>('retained-database-directories') ?? [];
        this.store.set('retained-database-directories', [...new Set([...retained, review.current!.databasePath])]);
        return previous.archive;
      });
    } else if (
      !operation.completed.includes('configure') &&
      !operation.receipts['configuration-intent'] &&
      this.installation()
    )
      throw new Refusal('installation_changed');
    const installation = await this.step(operation, 'configure', async () => {
      let intent = operation.receipts['configuration-intent'] as
        { installation: Installation; password: string } | undefined;
      if (!intent) {
        const suffix = await this.newInstallationId();
        const databasePath = await this.databaseStorage.allocate(review.databaseRoot, suffix, review.databaseBytes);
        const installation: Installation = {
          ...review.recovery.installation,
          mounts: review.mounts ?? review.recovery.installation.mounts,
          id: suffix,
          project: `frameleaf-${suffix}`,
          databaseRoot: review.databaseRoot,
          databasePath,
          sourceId: null,
          mayHaveWrittenMedia: false,
          origin: 'restored_library',
          libraryId: review.recovery.installation.libraryId ?? review.recovery.installation.id,
          importInstallation:
            review.recovery.installation.origin === 'new_import'
              ? review.recovery.installation.id
              : review.recovery.installation.origin === 'restored_library'
                ? review.recovery.installation.importInstallation
                : undefined,
        };
        intent = { installation, password: randomBytes(48).toString('base64url') };
        operation.receipts['configuration-intent'] = intent;
        this.store.save(operation);
      }
      const { installation, password } = intent;
      this.store.set('database-password', password);
      this.store.set('installation', installation);
      this.store.set('application-config', review.recovery.application);
      this.store.set('onboarding-finished', null);
      await mkdir(this.directory(), { recursive: true, mode: 0o700 });
      await this.managerToken();
      await renderCompose(review.release, installation, password, this.directory(), this.application());
      return installation;
    });
    await this.step(operation, 'start-database', async () => {
      await this.databaseStorage.verify(installation);
      await this.docker.compose(this.directory(), installation.project, 'up', ['database']);
      return true;
    });
    await this.step(operation, 'restore-new-database', async () => {
      const file = join(review.checkpoint, 'database.dump');
      if ((await fileHash(file)) !== review.hash) throw new Refusal('restore_checkpoint_changed');
      const database = await this.targetDatabase();
      await this.docker.verifyDump(database, file);
      if (
        Number(
          await this.docker.sql(
            database,
            `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';`,
          ),
        ) > 0
      )
        throw new Refusal('target_database_not_empty_recovery_required');
      await this.docker.restore(database, file);
      return true;
    });
    await this.step(operation, 'reconstruct-execution-state', async () => {
      // The admin CLI has no workers. Reconcile copied claims before any restored worker starts.
      // Lost acknowledgements can safely rerun the existing reset policy while workers remain stopped.
      await this.docker.restoreCommand(this.directory(), installation.project, operation.id);
      return true;
    });
    await this.step(operation, 'start-frameleaf', async () => {
      if (review.current) await this.fencing.verifyInstallation(review.current);
      await this.fencing.assertMedia(installation.mounts, installation);
      await this.releases.eligible(review.release.nas.tag);
      await assertMountSources(installation.mounts);
      // FL-1320: the restored database says thumbnails were checked; the library's own `thumbs` folder, chosen
      // in the review, gets the server's marker so it starts there. Any other missing marker still stops it.
      if (review.thumbnailFallback) await seedThumbnailMarker(review.thumbnailFallback.folder);
      installation.mayHaveWrittenMedia = true;
      this.store.set('installation', installation);
      await this.docker.compose(this.directory(), installation.project, 'up');
      return this.libraryStatus(true);
    });
  }
  async recover(id: string): Promise<void> {
    const operation = this.store.history().find((o) => o.id === id);
    if (!operation || this.executing.has(id) || !['failed', 'interrupted', 'awaiting-review'].includes(operation.state))
      throw new Refusal('operation_not_recoverable');
    // FL-1322: once started on the new folder the library may have written there; going back would lose that.
    if (operation.kind === 'move-database' && operation.receipts['start-state'] && !operation.receipts['cancellation-intent'])
      throw new Refusal('database_move_reverse_required');
    this.executing.add(id); // Claim synchronously, before any external effect or await.
    try {
      if (operation.kind === 'move-library') {
        await this.mediaMove.recover(operation);
        operation.state = 'complete';
        operation.error = operation.receipts['cancelled'] as string;
        this.store.save(operation);
        return;
      }
      if (!operation.receipts['cancellation-intent']) {
        const installation = this.installation();
        const kind =
          operation.kind === 'restore'
            ? 'restore'
            : operation.kind === 'backup'
              ? 'backup'
              : operation.kind === 'update' && !updateStarted(operation)
                ? 'update'
                : operation.kind === 'reconfigure'
                  ? 'reconfigure'
                  : operation.kind === 'move-database'
                    ? 'move-database'
                    : 'source';
        if (kind === 'source' && installation?.mayHaveWrittenMedia) throw new Refusal('manual_media_recovery_required');
        const restoreReview =
          kind === 'restore' ? this.store.get<RestoreReview>(`restore:${operation.input.reviewId}`) : null;
        if (kind === 'restore' && installation?.id !== restoreReview?.current?.id && installation?.mayHaveWrittenMedia)
          throw new Refusal('manual_media_recovery_required');
        operation.receipts['cancellation-intent'] = {
          kind,
          installation,
          archive: join(this.store.directory, `cancelled-stack-${operation.id}`),
        } satisfies Cancellation;
      }
      operation.state = 'running';
      this.store.save(operation);
      await this.cancelOperation(operation);
      operation.state = 'complete';
      operation.error = operation.receipts['cancelled'] as string;
      this.store.save(operation);
    } catch (error) {
      operation.state = 'failed';
      operation.error = error instanceof Refusal ? error.code : 'recovery_failed';
      this.store.save(operation);
      throw error;
    } finally {
      this.executing.delete(id);
      void this.retention.sweep();
    }
  }
  private async cancelOperation(operation: Operation): Promise<void> {
    const intent = operation.receipts['cancellation-intent'] as Cancellation;
    const installation = intent.installation;
    if (intent.kind === 'restore') {
      const review = this.store.get<RestoreReview>(`restore:${operation.input.reviewId}`);
      if (!review) throw new Refusal('review_missing');
      const previous = this.store.get<PreviousInstallation>(`previous-installation:${operation.id}`);
      const target = operation.receipts['configuration-intent'] as { installation: Installation } | undefined;
      if (target && installation?.id !== target.installation.id && installation?.id !== review.current?.id)
        throw new Refusal('installation_changed');
      if (target) {
        await this.step(operation, 'cancel-stop-target', async () => {
          await this.fencing.stopInstallation(target.installation);
          return true;
        });
        await this.step(operation, 'cancel-archive-stack', async () => {
          this.store.createOnce(`cancelled-installation:${operation.id}`, {
            installation,
            password: this.store.get('database-password'),
            application: this.application(),
          });
          if (
            await stat(this.directory()).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
              return null;
            })
          )
            await this.archiveStack(intent.archive);
          return true;
        });
      }
      await this.step(operation, 'cancel-restore-previous', async () => {
        if (previous) {
          await this.fencing.stopInstallation(previous.installation);
          if (
            operation.completed.includes('archive-previous-installation') ||
            operation.step === 'cancel-restore-previous'
          ) {
            try {
              await rename(previous.archive, this.directory());
            } catch (error: any) {
              if (error.code !== 'ENOENT' || !(await stat(this.directory()).catch(() => null))) throw error;
            }
            const parent = await open(this.store.directory, 'r');
            try {
              await parent.sync();
            } finally {
              await parent.close();
            }
          }
          this.store.set('installation', previous.installation);
          this.store.set('database-password', previous.password);
          this.store.set('application-config', previous.application);
          this.store.set('onboarding-finished', previous.onboardingFinished);
        } else if (!review.current) {
          this.store.set('installation', null);
          this.store.set('database-password', null);
          this.store.set('application-config', null);
        }
        return true;
      });
      operation.receipts['cancelled'] = previous
        ? 'restore_cancelled_previous_installation_stopped'
        : 'restore_cancelled';
      return;
    }
    if (intent.kind === 'backup') {
      operation.receipts['cancelled'] = 'backup_cancelled';
      return;
    }
    if (intent.kind === 'update') {
      if (!installation) throw new Refusal('no_installation');
      // 'prepared' means apply-release rendered the target's stack (and may have recorded it as the
      // installation) but never journaled its start: the previous release's record and compose.json are
      // put back before anything is started. Before that point nothing on disk changed.
      // FL-1265: a database move re-renders the stack on a new folder; its previous folder was never written again.
      const move = operation.receipts['database-move-intent'] as DatabaseMoveIntent | undefined;
      let previous = installation;
      if (operation.receipts['release-start-state'] === 'prepared' || move) {
        const review = this.store.get<UpdateReview>(`update:${operation.input.reviewId}`);
        if (!review) throw new Refusal('review_missing');
        previous = review.current;
      }
      await this.step(operation, 'cancel-restart-previous', async () => {
        if (move) {
          const retained = this.store.get<string[]>('retained-database-directories') ?? [];
          this.store.set('retained-database-directories', [...new Set([...retained, ...move.attempts])]);
        }
        if (previous !== installation) {
          this.store.set('installation', previous);
          await this.renderServices(previous, this.application().services);
        }
        await this.databaseStorage.verify(previous);
        await this.fencing.assertMedia(previous.mounts, previous);
        if (previous.sourceId)
          await this.verifySourceUntilTakeover(this.store.get<Source>(`source:${previous.sourceId}`)!, previous);
        await this.docker.compose(this.directory(), previous.project, 'up');
        return true;
      });
      operation.receipts['cancelled'] = 'update_cancelled_previous_release_running';
      return;
    }
    if (intent.kind === 'move-database') {
      const review = this.store.get<DatabaseRelocationReview>(`database-move:${operation.input.reviewId}`);
      if (!review) throw new Refusal('review_missing');
      return this.returnToOriginalDatabase(operation, review, 'database_relocation_cancelled');
    }
    if (intent.kind === 'reconfigure') {
      if (!installation) throw new Refusal('no_installation');
      await this.step(operation, 'restore-container-settings', async () => {
        // Absent when the apply never began: nothing changed, and the current settings are the previous ones.
        await this.renderServices(
          installation,
          ServiceOverrides.parse(operation.receipts['previous-container-settings'] ?? this.application().services),
        );
        return true;
      });
      await this.step(operation, 'start', () => this.composeAction(installation, 'start'));
      operation.receipts['cancelled'] = 'reconfigure_cancelled_previous_settings_running';
      return;
    }
    const common = operation.input.commonCapture && !operation.receipts['reviewed-common-import']
      ? undefined
      : this.store.get<Review>(`review:${operation.input.commonCapture ? operation.id : operation.input.reviewId}`)?.common;
    assertCommonImportReview(operation, common);
    if (common && operation.completed.includes('preflight-common-import')) {
      if (!installation || installation.mayHaveWrittenMedia || installation.sourceId !== common.fence.id)
        throw new Refusal('manual_media_recovery_required');
      await this.step(operation, 'cancel-common-import', async () => {
        await this.fencing.verify(common.fence, installation);
        const { source } = common.binding;
        await rollbackCommonImport(operation.id, source, (action) =>
          this.docker.importCommand(this.directory(), installation.project, operation.id, action, {
            source: source.kind,
            destinationId: common.destinationId,
            bundleName: common.bundleName,
            bootstrapAdminId: common.bootstrapAdminId,
            media: common.media,
            authority: {
              installation: installation.id,
              destinationId: common.destinationId,
              binding: common.binding,
              verify: () => this.fencing.verify(common.fence, installation),
            },
          }),
        );
        return true;
      });
    }
    if (common?.bootstrapAdminId) await removeCommonImportBootstrap(this.directory(), operation.id);
    const capturedFence = operation.receipts['common-source-fence'] as SourceFence | undefined;
    if (!installation && capturedFence) {
      await this.step(operation, 'cancel-source', async () => {
        await this.fencing.recover(capturedFence, null);
        return true;
      });
    }
    if (installation) {
      await this.step(operation, 'cancel-stop-target', async () => {
        // Configuration may not have been published when setup failed. Reconcile exact owned
        // containers independently of Compose, and prevent abandoned targets restarting.
        for (const container of (await this.docker.inventory()).filter(
          (c) => c.Config.Labels?.['app.frameleaf.manager'] === installation.id,
        )) {
          await this.docker.restartPolicy(container.Id, 'no');
          await this.docker.stop(container.Id);
        }
        return true;
      });
      await this.step(operation, 'cancel-import-reader', async () => {
        const source = installation.sourceId ? this.store.get<Source>(`source:${installation.sourceId}`) : null;
        const reader = this.store.get<{ name: string }>(`import-reader:${operation.id}`);
        // A retired source database already locked the reader at import-settings; cancel-source restarts it.
        if (source && reader && !this.fencing.retiredServices(source))
          await this.docker.sql(
            source.database,
            `DO $role$ BEGIN
          IF EXISTS (SELECT FROM pg_roles WHERE rolname='${reader.name}') THEN
            ALTER ROLE "${reader.name}" NOLOGIN;
          END IF; END $role$;`,
          );
        return true;
      });
      await this.step(operation, 'cancel-source', async () => {
        if (common) await this.fencing.recover(common.fence, installation);
        else if (installation.sourceId)
          await this.fencing.recover(this.store.get<Source>(`source:${installation.sourceId}`)!, installation);
        return true;
      });
      await this.step(operation, 'cancel-archive-stack', async () => {
        this.store.createOnce(`cancelled-installation:${operation.id}`, {
          installation,
          password: this.store.get('database-password'),
          application: this.application(),
        });
        try {
          await rename(this.directory(), intent.archive);
        } catch (error: any) {
          if (error.code !== 'ENOENT') throw error;
          const archived = await stat(intent.archive).catch((missing: any) => {
            if (missing.code !== 'ENOENT') throw missing;
            return null;
          });
          if (archived ? !archived.isDirectory() : operation.completed.includes('configure')) throw error;
        }
        const directory = await open(this.store.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        return intent.archive;
      });
      await this.step(operation, 'cancel-clear-installation', async () => {
        const current = this.installation();
        if (current && current.id !== installation.id) throw new Refusal('installation_changed');
        this.store.set('installation', null);
        this.store.set('database-password', null);
        this.store.set('application-config', null);
        return true;
      });
    }
    if (typeof operation.input.commonCapture === 'string') {
      await this.step(operation, 'cancel-photo-app', async () => {
        const plan = this.store.get<PhotoAppPlan>(`photo-app-plan:${operation.id}`);
        if (!installation) {
          // Nothing reached Frameleaf: the app runs again as it did before review. Restart first, so a failed
          // start can be retried while the plan still lists what was running.
          const present = await this.docker.inventory();
          for (const id of plan?.running ?? [])
            if (present.some((c) => c.Id === id && !c.State.Running)) await this.docker.start(id);
        }
        await this.removePhotoAppCopy(operation);
        if (!installation)
          await rm(join(this.directory(), `import-runtime-${operation.id}`), { recursive: true, force: true });
        return true;
      });
      if (!installation) {
        operation.receipts['cancelled'] = 'photo_app_import_cancelled';
        return;
      }
    }
    operation.receipts['cancelled'] = 'recovered_source_stopped';
  }
  /** Removes the disposable source database copy and forgets the source login and the copy's passwords. */
  private async removePhotoAppCopy(operation: Operation): Promise<void> {
    const restore = operation.receipts['photo-app-restore'];
    if (typeof restore === 'string') await this.docker.removeSourceRestore(restore);
    this.store.delete(`photo-app-plan:${operation.id}`);
    this.store.delete(`photo-app-restore:${operation.id}`);
  }
  history() {
    return this.store.history().map(({ input, receipts, ...operation }) => ({
      ...operation,
      ...(typeof input.commonCapture === 'string' && typeof input.photoApp === 'string' &&
        input.photoApp in importNames && {
          photoApp: { kind: input.photoApp, name: importNames[input.photoApp as keyof typeof importNames] },
        }),
      backupSkipped: operation.kind === 'import' && !!this.store.get<Review>(`review:${input.commonCapture ? operation.id : input.reviewId}`)?.backup,
      ...(typeof receipts['reviewed-common-import'] === 'string' && { commonImport: {
        requiresBootstrap: !!this.store.get<Review>(`review:${input.commonCapture ? operation.id : input.reviewId}`)?.common?.bootstrapAdminId,
      } }),
      replacesInstallation:
        operation.kind === 'restore' && !!this.store.get<RestoreReview>(`restore:${input.reviewId}`)?.current,
      databaseMove:
        operation.kind === 'update' &&
        (!!receipts['database-move-intent'] || !!this.store.get<UpdateReview>(`update:${input.reviewId}`)?.databaseMove),
      canStop: operation.kind === 'move-library' && operation.state === 'running' && !receipts['move-writes-intent'],
      canCancel:
        ['failed', 'interrupted', 'awaiting-review'].includes(operation.state) &&
        (operation.kind === 'move-library'
          ? !receipts['move-writes-intent']
          : operation.kind === 'move-database'
            ? !receipts['start-state']
            : operation.kind === 'backup' ||
            operation.kind === 'reconfigure' ||
            (operation.kind === 'update' && !updateStarted({ ...operation, receipts })) ||
            !this.installation()?.mayHaveWrittenMedia ||
            (operation.kind === 'restore' &&
              this.installation()?.id === this.store.get<RestoreReview>(`restore:${input.reviewId}`)?.current?.id)),
    }));
  }
  private async archiveStack(archive: string): Promise<void> {
    try {
      await rename(this.directory(), archive);
    } catch (error: any) {
      if (error.code !== 'ENOENT' || !(await stat(archive).catch(() => null))?.isDirectory()) throw error;
    }
    const parent = await open(this.store.directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
}
