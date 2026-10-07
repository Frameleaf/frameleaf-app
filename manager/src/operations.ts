import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, rename, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Store } from './store.js';
import { Docker } from './docker.js';
import { Discovery, COMPATIBLE_SETTINGS } from './discovery.js';
import { Releases, type VerifiedRelease } from './releases.js';
import { Backups, sourceBackups } from './backups.js';
import { Fencing } from './fencing.js';
import { ApplicationConfig, renderCompose, storagePath } from './compose.js';
import { atomicJson, copyVerified, fileHash } from './files.js';
import { PostgresStorage } from './postgres-storage.js';
import {
  Refusal,
  digest,
  recentBackup,
  releaseTag,
  type Installation,
  type Source,
  type Operation,
  type Database,
  type Backup,
  publicSource,
} from './contracts.js';

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
    databaseRoot: z.string().min(1).max(4096),
    port: z.number().int().min(1024).max(65535),
    ml: z.boolean(),
    lifecycle: z.literal('docker-only'),
  })
  .strict();
type Review = {
  id: string;
  expires: number;
  input: z.infer<typeof ReviewInput>;
  release: VerifiedRelease;
  source: Source | null;
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
};
type UpdateReview = { expires: number; current: Installation; release: VerifiedRelease; platform: string };
type Cancellation = {
  kind: 'backup' | 'update' | 'source' | 'restore';
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
  private discovery: Discovery;
  private fencing: Fencing;
  private executing = new Set<string>();
  constructor(
    readonly store: Store,
    readonly docker: Docker,
    readonly releases: Releases,
    readonly backups: Backups,
    private roots: string[],
    private databaseStorage: PostgresStorage,
    private autostartFile?: string,
  ) {
    this.discovery = new Discovery(docker);
    this.fencing = new Fencing(docker, store, autostartFile);
  }
  installation(): Installation | null {
    return this.store.get('installation');
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
    return found;
  }
  async librarySummary() {
    return JSON.parse(
      await this.docker.sql(
        await this.targetDatabase(),
        `SELECT json_build_object('assets',(SELECT count(*) FROM public.asset),'users',(SELECT count(*) FROM public.user),'albums',(SELECT count(*) FROM public.album));`,
      ),
    );
  }
  private async reviewedSource(id: string) {
    const source = this.store.get<Source>(`source:${id}`);
    if (!source) throw new Refusal('select_source_installation');
    await this.discovery.revalidate(source);
    if (source.unsupportedSettings.length) throw new Refusal('incompatible_settings_require_review');
    if (source.platform === 'unraid' && !this.autostartFile) throw new Refusal('unraid_autostart_file_required');
    return { source, backup: recentBackup(await sourceBackups(this.docker, source), source) ?? null };
  }
  async sourceReview(id: string) {
    if (this.installation()) throw new Refusal('installation_already_exists');
    const { source, backup } = await this.reviewedSource(id);
    return {
      source: publicSource(source),
      backup: backup ? { action: 'reuse', name: backup.name, takenAt: backup.takenAt } : { action: 'create' },
    };
  }
  async review(input: z.infer<typeof ReviewInput>) {
    if (this.installation()) throw new Refusal('installation_already_exists');
    const compatibility = await this.docker.compatibility();
    let source: Source | null = null,
      backup: Backup | null = null;
    if (input.kind === 'import') {
      ({ source, backup } = await this.reviewedSource(input.sourceId ?? ''));
    } else {
      if (!input.mediaPath) throw new Refusal('media_path_required');
      await storagePath(input.mediaPath, this.roots, 1024 ** 3);
    }
    await this.checkPort(input.port);
    const databaseStorage = await this.databaseStorage.validate(
      input.databaseRoot,
      (source?.summary.databaseBytes ?? 1024 ** 3) * 3,
    );
    await storagePath(this.store.directory, [this.store.directory], (source?.summary.databaseBytes ?? 1024 ** 3) * 3);
    const release = await this.releases.acquire(input.tag);
    if (!release.nas.platforms.includes(compatibility.platform)) throw new Refusal('release_architecture_unavailable');
    const review: Review = {
      id: randomUUID(),
      expires: Date.now() + 900_000,
      input,
      release,
      source,
      backup,
      platform: compatibility.platform,
    };
    this.store.set(`review:${review.id}`, review);
    return {
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
      backup: backup ? { action: 'reuse', name: backup.name, takenAt: backup.takenAt } : { action: 'create' },
      requiredBytes: (source?.summary.databaseBytes ?? 1024 ** 3) * 3,
      downtime: 'Immich stays stopped while Frameleaf imports and prepares the library.',
      recovery:
        'Database only. Photos, videos and external libraries stay in place. After Frameleaf writes to media, a database backup alone cannot safely return the library to Immich.',
    };
  }
  async checkPort(port: number, installation?: Installation | null): Promise<void> {
    const containers = await this.docker.inventory();
    if (
      containers.some(
        (c) =>
          c.State.Running &&
          (!installation || c.Config.Labels?.['app.frameleaf.manager'] !== installation.id) &&
          Object.values(c.HostConfig.PortBindings ?? {}).some((values) =>
            values?.some((v) => Number(v.HostPort) === port),
          ),
      )
    )
      throw new Refusal('port_in_use');
    // Docker's bind at compose up is the final authority for ports used by non-container host processes.
    if (port === Number(new URL(process.env.MANAGER_ORIGIN ?? 'https://localhost:9443').port || 443))
      throw new Refusal('port_in_use');
  }
  start(reviewId: string, key: string): Operation {
    const prior = this.store.request(undefined, key, { reviewId });
    if (prior) {
      if (!['install', 'import'].includes(prior.kind)) throw new Refusal('request_key_reused');
      return prior;
    }
    const review = this.store.get<Review>(`review:${reviewId}`);
    if (!review || review.expires < Date.now()) throw new Refusal('review_expired');
    const { operation, created } = this.store.start(review.input.kind, key, { reviewId });
    if (created) this.launch(operation, () => this.install(operation, review));
    return operation;
  }
  private launch(operation: Operation, work: () => Promise<void>): void {
    this.executing.add(operation.id);
    void work()
      .then(() => {
        operation.state = 'complete';
        operation.error = (operation.receipts['cancelled'] as string | undefined) ?? null;
        this.store.save(operation);
      })
      .catch((error) => {
        operation.state = 'failed';
        operation.error = error instanceof Refusal ? error.code : 'operation_failed';
        this.store.save(operation);
      })
      .finally(() => this.executing.delete(operation.id));
  }
  resume(id: string): Operation {
    const operation = this.store.history().find((o) => o.id === id);
    if (!operation || this.executing.has(id) || !['failed', 'interrupted'].includes(operation.state))
      throw new Refusal('operation_not_recoverable');
    operation.state = 'running';
    operation.error = null;
    this.store.save(operation);
    this.launch(operation, async () => {
      if (operation.receipts['cancellation-intent']) return this.cancelOperation(operation);
      if (operation.kind === 'update') {
        const review = this.store.get<UpdateReview>(`update:${operation.input.reviewId}`);
        if (!review) throw new Refusal('review_missing');
        return this.applyUpdate(operation, review);
      }
      if (['start', 'stop', 'restart', 'backup'].includes(operation.kind)) return this.runControl(operation);
      const restoring = operation.kind === 'restore';
      const review = this.store.get<Review | RestoreReview>(
        `${restoring ? 'restore' : 'review'}:${operation.input.reviewId}`,
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
      if (!restoring && (review as Review).source && operation.completed.includes('fence-source'))
        await this.fencing.verify((review as Review).source!, installation ?? undefined);
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
      else await this.install(operation, review as Review);
    });
    return operation;
  }
  private async step<T>(operation: Operation, name: string, action: () => Promise<T>): Promise<T> {
    if (operation.completed.includes(name)) return operation.receipts[name] as T;
    operation.step = name;
    this.store.save(operation); // fsync'd intent precedes the external effect
    const receipt = await action();
    operation.receipts[name] = receipt ?? null;
    operation.completed.push(name);
    operation.step = null;
    this.store.save(operation);
    return receipt;
  }
  private async install(operation: Operation, review: Review): Promise<void> {
    await this.step(operation, 'preflight', async () => {
      if (this.installation()) throw new Refusal('installation_already_exists');
      await this.releases.eligible(review.input.tag);
      if (review.source) await this.discovery.revalidate(review.source);
      await this.checkPort(review.input.port);
      await this.databaseStorage.validate(
        review.input.databaseRoot,
        (review.source?.summary.databaseBytes ?? 1024 ** 3) * 3,
      );
      return true;
    });
    await this.step(operation, 'download-images', async () => {
      const release = await this.releases.verify(review.release.directory, review.input.tag);
      for (const image of Object.values(release.nas.images).filter((v): v is string => typeof v === 'string'))
        await this.docker.pull(image, review.platform);
      return release.nas.tag;
    });
    const installation = await this.step(operation, 'configure', async () => {
      let intent = operation.receipts['configuration-intent'] as
        { installation: Installation; password: string } | undefined;
      if (!intent) {
        const id = randomBytes(6).toString('hex');
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
          origin: review.source ? 'new_import' : 'new_library',
          mounts: review.source?.mounts ?? [
            { type: 'bind', source: review.input.mediaPath!, target: '/data', readOnly: false },
          ],
          sourceId: review.source?.id ?? null,
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
    await this.step(operation, 'start-database', async () => {
      await this.databaseStorage.verify(installation);
      await this.docker.compose(this.directory(), installation.project, 'up', ['database']);
      return true;
    });
    if (source) {
      await this.step(operation, 'capture-fenced-settings', async () => {
        await this.fencing.verify(source);
        const settings =
          source.settingsAuthority === 'database'
            ? JSON.parse(
                await this.docker.sql(
                  source.database,
                  `SELECT coalesce((SELECT value FROM public.system_metadata WHERE key='system-config'), '{}'::jsonb);`,
                ),
              )
            : source.settings;
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
              urls: ['http://immich-machine-learning:3003'],
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
    }
    await this.step(operation, 'start-frameleaf', async () => {
      if (source) await this.fencing.verify(source);
      await this.fencing.assertMedia(installation.mounts, installation);
      await this.releases.eligible(review.input.tag);
      installation.mayHaveWrittenMedia = true;
      this.store.set('installation', installation);
      await this.docker.compose(this.directory(), installation.project, 'up');
      return true;
    });
    await this.step(operation, 'prepare-library', async () => this.libraryStatus(true));
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
    app.volumes = app.volumes.map((mount: Record<string, unknown>) => ({ ...mount, read_only: true }));
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
    const installation = this.installation();
    if (!installation) return null;
    const server = (await this.docker.inventory()).find(
      (c) =>
        c.Config.Labels?.['app.frameleaf.manager'] === installation.id &&
        c.Config.Labels?.['com.docker.compose.service'] === 'frameleaf-server',
    );
    if (!server?.State.Running) throw new Refusal('application_unavailable');
    const script = `const fs=require('node:fs');fetch('http://127.0.0.1:2283/api/server/library-setup/manager',{method:process.argv[1],headers:{'x-frameleaf-manager':fs.readFileSync('/run/frameleaf/manager-token','utf8').trim()}}).then(r=>{if(!r.ok)throw Error();return r.json()}).then(v=>process.stdout.write(JSON.stringify(v))).catch(()=>process.exit(1));`;
    return JSON.parse(await this.docker.node(server.Id, script, [begin ? 'POST' : 'GET']));
  }
  async targetDatabase(): Promise<Database> {
    const installation = this.installation();
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
  control(kind: 'start' | 'stop' | 'restart' | 'backup', key: string): Operation {
    const prior = this.store.request(kind, key, {});
    if (prior) return prior;
    const installation = this.installation();
    if (!installation) throw new Refusal('no_installation');
    const { operation, created } = this.store.start(kind, key, {});
    if (created) this.launch(operation, () => this.runControl(operation));
    return operation;
  }
  private async runControl(operation: Operation): Promise<void> {
    const installation = this.installation();
    if (!installation) throw new Refusal('no_installation');
    const kind = operation.kind;
    if (kind === 'backup') {
      await this.step(operation, 'database-backup', async () => {
        await this.backups.initialize();
        const checkpoint = await this.checkpoint(operation);
        return this.backups.snapshot(checkpoint, operation.id);
      });
    } else if (kind === 'start' || kind === 'stop' || kind === 'restart') {
      await this.step(operation, kind, async () => {
        if (kind !== 'stop') await this.databaseStorage.verify(installation);
        if (kind !== 'stop' && installation.sourceId)
          await this.fencing.verify(this.store.get<Source>(`source:${installation.sourceId}`)!, installation);
        if (kind !== 'stop') await this.fencing.assertMedia(installation.mounts, installation);
        await this.docker.compose(this.directory(), installation.project, kind === 'start' ? 'up' : kind);
        return true;
      });
    } else throw new Refusal('invalid_control_operation');
  }
  async reviewUpdate(tag: string) {
    const current = this.installation();
    if (!current || current.release === tag) throw new Refusal('select_a_new_release');
    const compatibility = await this.docker.compatibility();
    const release = await this.releases.acquire(tag);
    const existingCompose = JSON.parse(await readFile(join(this.directory(), 'compose.json'), 'utf8'));
    if (existingCompose.services.database.image !== release.nas.images.postgres)
      throw new Refusal('database_image_change_requires_restore');
    const postgres = JSON.parse(
      await this.docker.sql(
        await this.targetDatabase(),
        `SELECT json_build_object('major',current_setting('server_version_num')::int / 10000,
      'extensions',(SELECT json_agg(json_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension));`,
      ),
    );
    if (postgres.major !== 19) throw new Refusal('canonical_postgres_19_required');
    if (!release.nas.platforms.includes(compatibility.platform)) throw new Refusal('release_architecture_unavailable');
    const id = randomUUID();
    this.store.set(`update:${id}`, {
      id,
      expires: Date.now() + 900_000,
      current,
      release,
      platform: compatibility.platform,
    });
    return {
      id,
      from: current.release,
      to: tag,
      backupScope: 'database-only',
      recovery:
        'A database checkpoint is created before updating. Media changes require separate recovery before returning to older software.',
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
  private async applyUpdate(operation: Operation, review: UpdateReview): Promise<void> {
    await this.step(operation, 'download-images', async () => {
      await this.releases.eligible(review.release.nas.tag);
      await this.releases.verify(review.release.directory, review.release.nas.tag);
      for (const image of Object.values(review.release.nas.images).filter((v): v is string => typeof v === 'string'))
        await this.docker.pull(image, review.platform);
      return true;
    });
    await this.step(operation, 'stop-application', async () => {
      await this.docker.compose(this.directory(), review.current.project, 'stop', [
        'frameleaf-server',
        ...(review.current.ml ? ['immich-machine-learning'] : []),
      ]);
      return true;
    });
    await this.step(operation, 'database-checkpoint', async () => {
      await this.backups.initialize();
      return this.backups.snapshot(await this.checkpoint(operation), operation.id);
    });
    await this.step(operation, 'apply-release', async () => {
      await this.databaseStorage.verify(review.current);
      await this.releases.eligible(review.release.nas.tag);
      const installation = { ...review.current, release: review.release.nas.tag };
      this.store.set('previous-installation', review.current);
      const source = installation.sourceId ? this.store.get<Source>(`source:${installation.sourceId}`) : null;
      if (source) await this.fencing.verify(source, installation);
      await this.fencing.assertMedia(installation.mounts, installation);
      // PostgreSQL image changes require a logical restore into a new host directory.
      const oldCompose = JSON.parse(await readFile(join(this.directory(), 'compose.json'), 'utf8'));
      if (oldCompose.services.database.image !== review.release.nas.images.postgres)
        throw new Refusal('database_image_change_requires_restore');
      await renderCompose(
        review.release,
        installation,
        this.store.get<string>('database-password')!,
        this.directory(),
        this.application(),
      );
      this.store.set('installation', installation);
      await this.docker.compose(this.directory(), installation.project, 'up');
      return this.libraryStatus();
    });
  }
  async reviewRestore(snapshot: string, databaseRoot: string) {
    const current = this.installation();
    await this.databaseStorage.validate(databaseRoot, 1024 ** 3);
    const id = randomUUID(),
      checkpoint = join(this.store.directory, `restore-${id}`);
    await this.backups.restore(snapshot, checkpoint);
    const recovery = Recovery.parse(JSON.parse(await readFile(join(checkpoint, 'recovery.json'), 'utf8')));
    if (recovery.databaseFormat !== 'frameleaf-canonical')
      throw new Refusal('immich_source_checkpoint_requires_source_recovery');
    if (
      current &&
      ((current.libraryId ?? current.id) !== (recovery.installation.libraryId ?? recovery.installation.id) ||
        digest(current.mounts) !== digest(recovery.installation.mounts))
    )
      throw new Refusal('backup_belongs_to_another_library');
    await this.fencing.assertMedia(recovery.installation.mounts, current ?? undefined);
    const containers = await this.docker.inventory();
    for (const mount of recovery.installation.mounts) {
      if (mount.type === 'bind') await storagePath(mount.source, this.roots, 0);
      else if (!containers.some((c) => c.Mounts.some((m) => m.Type === 'volume' && m.Name === mount.source)))
        throw new Refusal('external_media_volume_unavailable');
      if (/^\/(?:proc|sys|dev|etc|run|var\/run)(?:\/|$)/.test(mount.target) || mount.target.includes('..'))
        throw new Refusal('unsafe_recovery_mount');
    }
    const compatibility = await this.docker.compatibility();
    const release = await this.releases.acquire(recovery.installation.release);
    if (!release.nas.platforms.includes(compatibility.platform)) throw new Refusal('release_architecture_unavailable');
    await this.checkPort(recovery.installation.port, current);
    const hash = await fileHash(join(checkpoint, 'database.dump'));
    if (hash !== recovery.dumpSha256) throw new Refusal('restore_checkpoint_changed');
    const databaseBytes = Math.max(1024 ** 3, (await stat(join(checkpoint, 'database.dump'))).size * 4);
    const databaseStorage = await this.databaseStorage.validate(databaseRoot, databaseBytes);
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
      platform: compatibility.platform,
      current,
    } satisfies RestoreReview);
    return {
      id,
      release: release.nas.tag,
      mounts: recovery.installation.mounts,
      port: recovery.installation.port,
      databaseStorage,
      mediaIncluded: false,
      replacesInstallation: !!current,
    };
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
      await this.releases.eligible(review.release.nas.tag);
      await this.releases.verify(review.release.directory, review.release.nas.tag);
      for (const image of Object.values(review.release.nas.images).filter((v): v is string => typeof v === 'string'))
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
        const suffix = randomBytes(6).toString('hex');
        const databasePath = await this.databaseStorage.allocate(review.databaseRoot, suffix, review.databaseBytes);
        const installation: Installation = {
          ...review.recovery.installation,
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
      installation.mayHaveWrittenMedia = true;
      this.store.set('installation', installation);
      await this.docker.compose(this.directory(), installation.project, 'up');
      return this.libraryStatus(true);
    });
  }
  async recover(id: string): Promise<void> {
    const operation = this.store.history().find((o) => o.id === id);
    if (!operation || this.executing.has(id) || !['failed', 'interrupted'].includes(operation.state))
      throw new Refusal('operation_not_recoverable');
    this.executing.add(id); // Claim synchronously, before any external effect or await.
    try {
      if (!operation.receipts['cancellation-intent']) {
        const installation = this.installation();
        const kind =
          operation.kind === 'restore'
            ? 'restore'
            : operation.kind === 'backup'
              ? 'backup'
              : operation.kind === 'update' &&
                  !operation.completed.includes('apply-release') &&
                  operation.step !== 'apply-release'
                ? 'update'
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
      await this.step(operation, 'cancel-restart-previous', async () => {
        await this.databaseStorage.verify(installation);
        await this.fencing.assertMedia(installation.mounts, installation);
        if (installation.sourceId)
          await this.fencing.verify(this.store.get<Source>(`source:${installation.sourceId}`)!, installation);
        await this.docker.compose(this.directory(), installation.project, 'up');
        return true;
      });
      operation.receipts['cancelled'] = 'update_cancelled_previous_release_running';
      return;
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
        if (source && reader)
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
        if (installation.sourceId)
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
    operation.receipts['cancelled'] = 'recovered_source_stopped';
  }
  history() {
    return this.store
      .history()
      .map(({ input, receipts, ...operation }) => ({
        ...operation,
        backupSkipped: operation.kind === 'import' && !!this.store.get<Review>(`review:${input.reviewId}`)?.backup,
        replacesInstallation:
          operation.kind === 'restore' && !!this.store.get<RestoreReview>(`restore:${input.reviewId}`)?.current,
        canCancel:
          ['failed', 'interrupted'].includes(operation.state) &&
          (operation.kind === 'backup' ||
            (operation.kind === 'update' &&
              operation.step !== 'apply-release' &&
              !operation.completed.includes('apply-release')) ||
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
