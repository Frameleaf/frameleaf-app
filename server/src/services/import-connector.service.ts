import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import path from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { MediaOperationCreate } from 'src/repositories/media-operation.repository.js';
import { OnEvent } from 'src/decorators.js';
import {
  ImportConnectionCreateDto,
  ImportConnectionFoldersResponseDto,
  ImportConnectionProvidersResponseDto,
  ImportConnectionResponseDto,
  ImportConnectionRootsDto,
  ImportConnectionStatisticsResponseDto,
  ImportConnectionUpdateDto,
} from 'src/dtos/import-connector.dto.js';
import {
  TakeoutControlDto,
  TakeoutItemQueryDto,
  TakeoutItemsResponseDto,
  TakeoutOptionsDto,
  TakeoutResponseDto,
} from 'src/dtos/takeout.dto.js';
import { FrameleafEnvironment, MediaOperationDestination, MediaOperationKind, Permission } from 'src/enum.js';
import { fakeRemoteSourceProvider } from 'src/import-connectors/fake.source.js';
import {
  RemoteSourceError,
  registerRemoteSource,
  remoteSourceProvider,
  remoteSourceProviders,
} from 'src/import-connectors/remote-source.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import {
  IMPORT_CONNECTION_ACTIVE,
  ImportConnection,
  ImportConnectorRepository,
} from 'src/repositories/import-connector.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  TakeoutConflict,
  TakeoutImport,
  TakeoutNotFound,
  TakeoutOperation,
  TakeoutRepository,
  takeoutOperationFor,
} from 'src/repositories/takeout.repository.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { TAKEOUT_MAX_ATTEMPTS } from 'src/services/takeout.service.js';
import { checkAccess, requireUploadsNotPaused } from 'src/utils/access.js';
import { openImportConnection, readImportCredentials, sealImportCredentials } from 'src/utils/import-connector.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import {
  TAKEOUT_BUSY_STATES,
  TAKEOUT_DEFAULT_OPTIONS,
  TAKEOUT_REVIEWABLE_STATES,
  TakeoutAction,
  isTakeoutAlbumSelected,
  parseTakeoutOptions,
  takeoutState,
} from 'src/utils/takeout.js';

/**
 * The job for one step of a connection's run. It is a `takeout_import` media operation like a Google
 * Photos import's, so the same worker claims it and Activity pauses, cancels and retries it; `auto`
 * marks the daily check's scan, which goes on to import what it found without waiting for a review.
 */
export const importConnectionOperation = (
  connection: Pick<ImportConnection, 'ownerId' | 'displayName'>,
  importId: string,
  action: TakeoutAction,
  extra: { retryOfId?: string; auto?: boolean } = {},
): MediaOperationCreate => ({
  ownerId: connection.ownerId,
  kind: MediaOperationKind.TakeoutImport,
  destination: MediaOperationDestination.Local,
  destinationDetail: null,
  label: connection.displayName,
  assetId: null,
  resultAssetId: null,
  retryOfId: extra.retryOfId ?? null,
  projectId: null,
  revisionId: null,
  snapshot: { importId, action, ...(extra.auto && { auto: true }) },
  settings: {},
  estimate: null,
  result: null,
  totalUnits: null,
  maxAttempts: TAKEOUT_MAX_ATTEMPTS,
});

const asIso = (value: Date) => value.toISOString();

/**
 * Import connections, the request side (FL-920): remote folders that become reviewed imports.
 *
 * connect → choose folders → scan → review → import, and a daily check for what is new. A scan and an
 * import are a run: a `takeout_import` row that names the connection, carried out by the Google Photos
 * import's worker and answered in its shapes. `ImportConnectorWorkerService` does the part that
 * differs: listing the source and downloading from it.
 *
 * The rules this side keeps:
 *
 * - **Owner only.** Every connection and run is read through its owner; another account's is "not
 *   found". An administrator is told how many connections exist and nothing else.
 * - **Credentials stay sealed.** They are checked against the source once, sealed, and never returned,
 *   logged or put in an error. Only a source's own `RemoteSourceError` message reaches the owner.
 * - **The source is only read.** A `RemoteSource` has no way to delete, move or rename anything.
 * - **One job at a time** per connection.
 */
@Injectable()
export class ImportConnectorService {
  constructor(
    private logger: LoggingRepository,
    private repository: ImportConnectorRepository,
    private takeout: TakeoutRepository,
    private mediaOperations: MediaOperationService,
    private access: AccessRepository,
    private crypto: CryptoRepository,
    private config: ConfigRepository,
  ) {
    this.logger.setContext(ImportConnectorService.name);
  }

  /** The in-memory test source exists only on a server started for tests (the e2e stack). */
  @OnEvent({ name: 'AppBootstrap' })
  onBootstrap() {
    if (this.config.getEnv().environment === FrameleafEnvironment.Testing) {
      registerRemoteSource(fakeRemoteSourceProvider);
    }
  }

  providers(): ImportConnectionProvidersResponseDto {
    return { providers: remoteSourceProviders() };
  }

  /** Counts only: an administrator never sees whose connections they are or where they point. */
  async statistics(): Promise<ImportConnectionStatisticsResponseDto> {
    const providers = await this.repository.statistics();
    return { total: providers.reduce((total, { connections }) => total + connections, 0), providers };
  }

  async list(auth: AuthDto): Promise<ImportConnectionResponseDto[]> {
    this.requireSession(auth);
    const connections = await this.repository.list(auth.user.id);
    const imported = await this.repository.importedCounts(connections.map(({ id }) => id));
    return connections.map((connection) => this.present(connection, imported.get(connection.id) ?? 0));
  }

  async get(auth: AuthDto, id: string): Promise<ImportConnectionResponseDto> {
    this.requireSession(auth);
    const connection = await this.findOwned(auth, id);
    const imported = await this.repository.importedCounts([id]);
    return this.present(connection, imported.get(id) ?? 0);
  }

  /** Connect: the source is asked for its top folders once, so a wrong sign-in is refused here. */
  async create(auth: AuthDto, dto: ImportConnectionCreateDto): Promise<ImportConnectionResponseDto> {
    this.requireSession(auth);
    const credentials = await this.checkCredentials(dto.provider, dto.credentials);
    const id = this.crypto.randomUUID();
    const connection = await this.repository.create({
      id,
      ownerId: auth.user.id,
      provider: dto.provider,
      displayName: dto.displayName,
      sealedCredentials: await sealImportCredentials(this.sealDeps, id, credentials),
      roots: dto.roots,
      dailyCheck: dto.dailyCheck,
    });
    this.logger.log(`Import connection ${id} (${dto.provider}) created`);
    return this.present(connection, 0);
  }

  async update(auth: AuthDto, id: string, dto: ImportConnectionUpdateDto): Promise<ImportConnectionResponseDto> {
    this.requireSession(auth);
    const connection = await this.findOwned(auth, id);
    const credentials = dto.credentials && (await this.checkCredentials(connection.provider, dto.credentials));
    await this.repository.update(id, {
      displayName: dto.displayName,
      dailyCheck: dto.dailyCheck,
      sealedCredentials: credentials && (await sealImportCredentials(this.sealDeps, id, credentials)),
    });
    return this.get(auth, id);
  }

  async setRoots(auth: AuthDto, id: string, dto: ImportConnectionRootsDto): Promise<ImportConnectionResponseDto> {
    this.requireSession(auth);
    await this.findOwned(auth, id);
    await this.repository.update(id, { roots: dto.roots });
    return this.get(auth, id);
  }

  /** Disconnect. The connection and its runs go; every photo it brought in stays in the library. */
  async remove(auth: AuthDto, id: string): Promise<void> {
    this.requireSession(auth);
    const connection = await this.repository.get(auth.user.id, id);
    const outcome = await this.repository.delete(auth.user.id, id);
    if (outcome === 'missing') {
      throw new NotFoundException('Connection not found');
    }
    if (outcome === 'busy') {
      throw new BadRequestException('Cancel the running job before removing this connection');
    }
    this.logger.log(`Import connection ${id} removed`);
    if (connection) {
      await this.giveUpAccess(connection);
    }
  }

  /** Ask the source to end the access a removed connection held. It is gone here whatever the answer. */
  private async giveUpAccess(connection: ImportConnection) {
    const provider = remoteSourceProvider(connection.provider);
    if (!provider?.revoke) {
      return;
    }
    try {
      const credentials = await readImportCredentials(this.sealDeps, connection);
      if (credentials) {
        await provider.revoke(credentials);
      }
    } catch (error) {
      this.logger.warn(
        `Import connection ${connection.id}: access was not revoked at the source (${error instanceof Error ? error.name : 'error'})`,
      );
    }
  }

  /** The folders inside a folder at the source, for choosing what to import. */
  async folders(auth: AuthDto, id: string, folder: string): Promise<ImportConnectionFoldersResponseDto> {
    this.requireSession(auth);
    const connection = await this.findOwned(auth, id);
    const folders = await this.asking(async () => {
      const source = await openImportConnection(this.sealDeps, connection);
      return source.listFolders(folder);
    });
    return { folders: folders.map(({ path, name }) => ({ path, name })) };
  }

  /** Look at the source for what is new. The scan runs on the server; closing the browser does not stop it. */
  async scan(auth: AuthDto, id: string): Promise<TakeoutResponseDto> {
    this.requireSession(auth);
    const connection = await this.findOwned(auth, id);
    if (connection.status !== IMPORT_CONNECTION_ACTIVE) {
      throw new BadRequestException('Sign in to this connection again before scanning');
    }
    const started = await this.repository.startScan(id, { ...TAKEOUT_DEFAULT_OPTIONS }, (current, importId) =>
      importConnectionOperation(current, importId, 'scan'),
    );
    if (started === 'busy') {
      throw new BadRequestException('A job is already working on this connection');
    }
    if (typeof started === 'string') {
      throw new NotFoundException('Connection not found');
    }
    this.logger.log(`Import connection ${id}: scan queued as run ${started.importId}`);
    return this.run(auth, id, started.importId);
  }

  async runs(auth: AuthDto, id: string): Promise<TakeoutResponseDto[]> {
    this.requireSession(auth);
    await this.findOwned(auth, id);
    const rows = await this.takeout.listForConnection(auth.user.id, id);
    const latest = await this.takeout.latestOperations(
      auth.user.id,
      rows.map((row) => row.id),
    );
    return Promise.all(
      rows.map((row) =>
        this.presentRun(
          auth,
          row,
          takeoutOperationFor(
            row.phase,
            latest.filter(({ importId }) => importId === row.id).map(({ operation }) => operation),
          ),
          false,
        ),
      ),
    );
  }

  async run(auth: AuthDto, id: string, runId: string): Promise<TakeoutResponseDto> {
    this.requireSession(auth);
    const row = await this.findRun(auth, id, runId);
    return this.presentRun(auth, row, await this.currentOperation(auth, row), true);
  }

  /** What a run found, for review: each file, and once it has been imported what became of it. */
  async items(auth: AuthDto, id: string, runId: string, query: TakeoutItemQueryDto): Promise<TakeoutItemsResponseDto> {
    this.requireSession(auth);
    const row = await this.findRun(auth, id, runId);
    const page = await this.repository.items(runId, {
      state: query.state,
      offset: query.offset ?? 0,
      limit: query.limit ?? 100,
      includeLocked: !!getLockedOwnerId(auth),
    });
    const assetIds = page.items.flatMap((item) => (item.assetId ? [item.assetId] : []));
    const readable =
      assetIds.length > 0
        ? await checkAccess(this.access, { auth, permission: Permission.AssetRead, ids: assetIds })
        : new Set<string>();
    return {
      total: page.total,
      hiddenLocked: page.hiddenLocked,
      items: page.items.map((item) => {
        const name = path.posix.basename(item.path);
        return {
          id: item.id,
          path: item.path,
          folder: item.albumHint ?? '',
          source: row.name,
          kind: mimeTypes.isVideo(name) ? ('video' as const) : ('image' as const),
          size: item.size,
          state: item.state,
          assetId: item.assetId && readable.has(item.assetId) ? item.assetId : null,
          metadata: {
            title: name,
            ...(item.caption && { description: item.caption }),
            ...(item.favourite && { favorite: true }),
          },
          candidates: [],
          sidecarId: null,
          albums: item.albumHint ? [item.albumHint] : [],
          warnings: [],
          locked: false,
          error: item.error,
        };
      }),
    };
  }

  /**
   * Import what the run found with the owner's choices, or import again after it stopped or left
   * files behind. Files already imported are never imported twice; downloads that failed are tried again.
   */
  async startImport(auth: AuthDto, id: string, runId: string, dto: TakeoutOptionsDto): Promise<TakeoutResponseDto> {
    this.requireSession(auth);
    requireUploadsNotPaused(auth);
    const connection = await this.findOwned(auth, id);
    const options = parseTakeoutOptions(dto);
    await this.mapErrors(() =>
      this.takeout.withImport(
        auth.user.id,
        runId,
        async (tx, row, operation) => {
          if (row.connectionId !== id) {
            throw new TakeoutNotFound('Run not found');
          }
          const state = takeoutState(row.phase, operation);
          if (row.phase === 'scanning' || !TAKEOUT_REVIEWABLE_STATES.includes(state)) {
            throw new TakeoutConflict('This run is not ready to import yet');
          }
          await this.takeout.setOptions(tx, runId, options);
          await this.repository.retryFailed(runId, tx);
          const stopped = state === 'failed' || state === 'cancelled';
          await this.takeout.setPhase(tx, runId, 'importing');
          await this.takeout.insertOperation(
            tx,
            importConnectionOperation(connection, runId, 'import', {
              retryOfId: row.phase === 'importing' && stopped ? operation?.id : undefined,
            }),
          );
        },
        true,
      ),
    );
    return this.run(auth, id, runId);
  }

  /** Pause, resume or cancel the job working on a run, through the durable job itself. */
  async control(auth: AuthDto, id: string, runId: string, dto: TakeoutControlDto): Promise<TakeoutResponseDto> {
    this.requireSession(auth);
    const row = await this.findRun(auth, id, runId);
    const operation = await this.currentOperation(auth, row);
    if (!operation || !TAKEOUT_BUSY_STATES.includes(takeoutState(row.phase, operation))) {
      throw new BadRequestException('Nothing is running for this connection');
    }
    switch (dto.action) {
      case 'pause': {
        await this.mediaOperations.pause(auth, operation.id);
        break;
      }
      case 'resume': {
        await this.mediaOperations.resume(auth, operation.id);
        break;
      }
      case 'cancel': {
        await this.mediaOperations.cancel(auth, operation.id);
        break;
      }
    }
    return this.run(auth, id, runId);
  }

  private get sealDeps() {
    return { crypto: this.crypto, config: this.config, repository: this.repository };
  }

  /** What is sealed for a connection, after the source accepted it. */
  private async checkCredentials(providerName: string, input: Record<string, unknown>) {
    const provider = remoteSourceProvider(providerName);
    if (!provider) {
      throw new BadRequestException('This kind of connection is not available on this server');
    }
    return this.asking(async () => {
      const credentials = await provider.credentials(input);
      await provider.open(credentials).listFolders('');
      return credentials;
    });
  }

  /**
   * Ask the source something for a request. Only what the source chose to say (`RemoteSourceError`)
   * is passed on; any other failure could quote a request, so it is answered in general terms and its
   * text is not logged.
   */
  private async asking<T>(ask: () => Promise<T>): Promise<T> {
    try {
      return await ask();
    } catch (error) {
      if (error instanceof RemoteSourceError) {
        throw new BadRequestException(error.message);
      }
      this.logger.warn(`An import source could not be reached (${error instanceof Error ? error.name : 'error'})`);
      throw new BadRequestException('The source could not be reached. Check the details and try again.');
    }
  }

  private present(connection: ImportConnection, importedItems: number): ImportConnectionResponseDto {
    return {
      id: connection.id,
      provider: connection.provider,
      displayName: connection.displayName,
      status: connection.status,
      roots: connection.roots,
      dailyCheck: connection.dailyCheck,
      lastScanAt: connection.lastScanAt ? asIso(connection.lastScanAt) : null,
      importedItems,
      createdAt: asIso(connection.createdAt),
      updatedAt: asIso(connection.updatedAt),
    };
  }

  private async presentRun(
    auth: AuthDto,
    row: TakeoutImport,
    operation: TakeoutOperation | undefined,
    detail: boolean,
  ): Promise<TakeoutResponseDto> {
    const options = parseTakeoutOptions(row.options);
    const [sources, { states, hiddenLocked }, albums] = await Promise.all([
      this.takeout.sources(row.id),
      this.repository.counts(row.id),
      detail ? this.repository.albums(row.id) : Promise.resolve([]),
    ]);
    const count = (state: keyof typeof states) => states[state] ?? 0;
    const items = Object.values(states).reduce((total, value) => total + value, 0);
    const action = operation?.snapshot.action;
    return {
      id: row.id,
      name: row.name,
      state: takeoutState(row.phase, operation),
      phase: row.phase,
      action: action === 'scan' || action === 'import' ? action : null,
      operationId: operation?.id ?? null,
      processed: operation?.processedUnits ?? 0,
      total: operation?.totalUnits ?? null,
      error: operation?.error ?? null,
      errorCode: operation?.errorCode ?? null,
      createdAt: asIso(row.createdAt),
      updatedAt: asIso(row.updatedAt),
      counts: {
        files: items,
        items,
        ready: count('ready'),
        review: count('review'),
        importing: count('importing'),
        imported: count('imported'),
        matched: count('matched'),
        skipped: count('skipped'),
        failed: count('failed'),
        // Whether a file is already in the library is only known once it has been downloaded and hashed.
        newAssets: count('ready'),
        matchedOriginals: count('matched'),
        suggestedPairs: 0,
        unresolvedPairs: 0,
        hiddenLocked: getLockedOwnerId(auth) ? 0 : hiddenLocked,
        rejected: sources.reduce((total, source) => total + source.rejected, 0),
      },
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.kind,
        size: source.size,
        received: source.received,
        scanned: source.scanned,
        rejected: source.rejected,
      })),
      options,
      albums: albums.map(({ folder, count: total }) => ({
        folder,
        name: path.posix.basename(folder),
        count: total,
        selected: isTakeoutAlbumSelected(folder, options),
        year: false,
      })),
    };
  }

  private async currentOperation(auth: AuthDto, row: TakeoutImport): Promise<TakeoutOperation | undefined> {
    const latest = await this.takeout.latestOperations(auth.user.id, [row.id]);
    return takeoutOperationFor(
      row.phase,
      latest.map(({ operation }) => operation),
    );
  }

  private requireSession(auth: AuthDto) {
    if (auth.sharedLink) {
      throw new ForbiddenException('Imports are not available on a shared link');
    }
  }

  private async findOwned(auth: AuthDto, id: string): Promise<ImportConnection> {
    const connection = await this.repository.get(auth.user.id, id);
    if (!connection) {
      throw new NotFoundException('Connection not found');
    }
    return connection;
  }

  private async findRun(auth: AuthDto, id: string, runId: string): Promise<TakeoutImport> {
    const row = await this.takeout.get(auth.user.id, runId, true);
    if (!row || row.connectionId !== id) {
      throw new NotFoundException('Run not found');
    }
    return row;
  }

  private async mapErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof TakeoutNotFound) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof TakeoutConflict) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
