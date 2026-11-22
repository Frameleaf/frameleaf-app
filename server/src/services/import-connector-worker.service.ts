import { Injectable } from '@nestjs/common';
import path from 'node:path';
import { OnEvent } from 'src/decorators.js';
import { FrameleafWorker } from 'src/enum.js';
import {
  type RemoteItem,
  type RemoteScanBatch,
  type RemoteSource,
  RemoteSourceAuthError,
  RemoteSourceError,
  RemoteSourceUnavailableError,
} from 'src/import-connectors/remote-source.js';
import { importFilePathSchema } from 'src/library-import/manifest.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import {
  IMPORT_CONNECTION_SIGN_IN_REQUIRED,
  ImportConnection,
  ImportConnectorRepository,
} from 'src/repositories/import-connector.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  StagedDigest,
  TAKEOUT_STAGING_RESERVE_BYTES,
  TakeoutStagingError,
  TakeoutStagingRepository,
} from 'src/repositories/takeout-staging.repository.js';
import { TakeoutImport, TakeoutRepository } from 'src/repositories/takeout.repository.js';
import { importConnectionOperation } from 'src/services/import-connector.service.js';
import { openImportConnection } from 'src/utils/import-connector.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { TAKEOUT_DEFAULT_OPTIONS, TakeoutJobError, takeoutStableId } from 'src/utils/takeout.js';

/** How often the worker looks for connections whose daily check is due. */
export const IMPORT_CONNECTION_TICK_MS = 60 * 60_000;
/** A connection is checked at most this often, however its last scan ended. */
export const IMPORT_CONNECTION_DAILY_MS = 24 * 60 * 60_000;

const CAPTION_MAX = 100_000;
const NO_SPACE = 'The server ran out of space for staging this import. Free some space, then retry.';

/** A file the framework can import: a safe relative path naming a photo or video, with a sane size and date. */
const acceptable = ({ remoteId, path: filePath, albumHint, size, modifiedAt }: RemoteItem) =>
  typeof remoteId === 'string' &&
  remoteId.length > 0 &&
  remoteId.length <= 4096 &&
  importFilePathSchema.safeParse(filePath).success &&
  (albumHint === null || importFilePathSchema.safeParse(albumHint).success) &&
  Number.isSafeInteger(size) &&
  size >= 0 &&
  modifiedAt instanceof Date &&
  !Number.isNaN(modifiedAt.getTime()) &&
  mimeTypes.isAsset(path.posix.basename(filePath));

/**
 * Import connections, the worker side (FL-920): the two things a connection's run does differently
 * from a Google Photos import. `TakeoutWorkerService` owns the job (claim, progress, pause, cancel,
 * retry) and calls in here; everything after a file is staged is its import path, unchanged.
 *
 * - **Scan** lists the source and offers the run every file the connection has not seen, or that
 *   changed since. Nothing is downloaded. A file that is no longer listed is not looked for and nothing
 *   is done about it: the photo it became stays exactly as it is.
 * - **Stage** downloads the next few files of a run into staging just before they are imported,
 *   resuming a download that was cut short, and records each as the `takeout_file` and `takeout_item`
 *   the import path expects: the caption as its description, the favourite flag, the album hint as its
 *   album folder. The library's digests are computed here, from the bytes that arrived.
 * - **Daily check** starts a scan for each connection that asks for one and has not been scanned for a
 *   day; that scan's run imports what it found without waiting for a review.
 *
 * A source that refuses the saved sign-in marks its connection `sign_in_required`; the job fails
 * without its automatic retry and the daily check leaves the connection alone until the owner signs in
 * again. Credentials and whatever a failed request said are never logged: only a source's own
 * `RemoteSourceError` message is.
 */
@Injectable()
export class ImportConnectorWorkerService {
  private tickHandle?: ReturnType<typeof setInterval>;

  constructor(
    private logger: LoggingRepository,
    private repository: ImportConnectorRepository,
    private takeout: TakeoutRepository,
    private staging: TakeoutStagingRepository,
    private crypto: CryptoRepository,
    private config: ConfigRepository,
  ) {
    this.logger.setContext(ImportConnectorWorkerService.name);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    this.tickHandle ??= setInterval(() => void this.dailyCheck(), IMPORT_CONNECTION_TICK_MS);
    void this.dailyCheck();
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
  }

  /** Start a scan for every connection whose daily check is due. Returns how many were started. */
  async dailyCheck(now = new Date()): Promise<number> {
    let started = 0;
    await this.resumeDailyImports();
    try {
      const dueBefore = new Date(now.getTime() - IMPORT_CONNECTION_DAILY_MS);
      for (const id of await this.repository.dueForDailyCheck(dueBefore)) {
        const outcome = await this.repository.startScan(
          id,
          { ...TAKEOUT_DEFAULT_OPTIONS },
          (connection, importId) => importConnectionOperation(connection, importId, 'scan', { auto: true }),
          dueBefore,
        );
        if (typeof outcome !== 'string') {
          started++;
        }
      }
    } catch (error) {
      this.logger.warn(
        `The daily check of import connections failed (${error instanceof Error ? error.name : 'error'})`,
      );
    }
    return started;
  }

  /** A daily scan that finished just as the process stopped still gets its import. */
  private async resumeDailyImports(): Promise<void> {
    try {
      for (const id of await this.repository.dailyRunsAwaitingImport()) {
        const row = await this.takeout.getById(id);
        if (row?.phase === 'review') {
          await this.continueDailyCheck(row);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Resuming the daily imports of connections failed (${error instanceof Error ? error.name : 'error'})`,
      );
    }
  }

  /**
   * List the source for a run and offer it what is new. `listed` is told how many files each batch
   * held, and may stop the scan by throwing. The cursor is stored only when the whole listing is in.
   */
  async scan(row: TakeoutImport, signal: AbortSignal, listed: (files: number) => Promise<void>): Promise<void> {
    const { connection, source } = await this.open(row);
    const [stagingSource] = await this.takeout.sources(row.id);
    let cursor = connection.cursor;
    let rejected = 0;
    let skippedFolders = 0;
    let batches: AsyncIterator<RemoteScanBatch> | undefined;
    // Only the source's own failure is a source failure; a stop from `listed` passes straight through.
    const read = async () => {
      try {
        batches ??= source.scan(connection.roots, connection.cursor, signal)[Symbol.asyncIterator]();
        return await batches.next();
      } catch (error) {
        throw await this.sourceFailure(connection, signal, error, 'The source could not be read');
      }
    };
    try {
      for (let next = await read(); !next.done; next = await read()) {
        for (const item of next.value.items) {
          if (!acceptable(item)) {
            rejected++;
            continue;
          }
          await this.repository.offer(connection.id, row.id, {
            ...item,
            caption: item.caption?.slice(0, CAPTION_MAX),
          });
        }
        if (next.value.cursor !== undefined) {
          cursor = next.value.cursor;
        }
        skippedFolders += next.value.skippedFolders ?? 0;
        await listed(next.value.items.length);
      }
    } finally {
      await batches?.return?.();
    }
    if (stagingSource) {
      await this.takeout.markSourceScanned(stagingSource.id, rejected);
    }
    await this.repository.setCursor(connection.id, cursor);
    if (skippedFolders > 0) {
      this.logger.warn(
        `Import connection ${connection.id}: ${skippedFolders} folders could not be read and were skipped`,
      );
    }
    this.logger.log(`Import connection ${connection.id}: scan of run ${row.id} finished`);
  }

  /**
   * After the daily check's scan: import what it found without a review, or drop the run when there
   * was nothing new. Called once the scan's job has finished, so the import's job can take the run.
   */
  async continueDailyCheck(row: TakeoutImport): Promise<void> {
    if ((await this.repository.pendingCount(row.id)) === 0) {
      await this.repository.deleteEmptyRun(row.id);
      return;
    }
    const connection = row.connectionId ? await this.repository.getById(row.connectionId) : undefined;
    if (!connection) {
      return;
    }
    await this.takeout.withImport(
      row.ownerId,
      row.id,
      async (tx, current) => {
        // One job per connection: a run left waiting here is picked up by the next daily check.
        if (current.phase !== 'review' || !(await this.repository.lockIdle(tx, connection.id))) {
          return;
        }
        await this.takeout.setPhase(tx, row.id, 'importing');
        await this.takeout.insertOperation(tx, importConnectionOperation(connection, row.id, 'import', { auto: true }));
      },
      true,
    );
  }

  /** Files of the run still to download. */
  pendingCount(importId: string): Promise<number> {
    return this.repository.pendingCount(importId);
  }

  /** Downloads that failed get the run's one automatic retry, with the items that failed to import. */
  retryFailed(importId: string): Promise<number> {
    return this.repository.retryFailed(importId);
  }

  /**
   * Download the run's next files into staging and hand them to the import path. Returns how many
   * files it dealt with, staged or failed; zero when the run has nothing left to download. A file that
   * cannot be downloaded is reported on its own and the run carries on.
   */
  async stage(row: TakeoutImport, signal: AbortSignal, limit: number): Promise<number> {
    const items = await this.repository.pendingItems(row.id, limit);
    if (items.length === 0) {
      return 0;
    }
    const { connection, source } = await this.open(row);
    const [stagingSource] = await this.takeout.sources(row.id);
    if (!stagingSource) {
      throw new TakeoutJobError('import_connection_run_invalid', 'This run has lost its record of the source');
    }
    const directory = await this.staging.prepare(row.ownerId, row.id);
    let handled = 0;
    // Files already staged are imported before the run stops or moves on, which can also free the space.
    const canDrain = async () => handled > 0 || (await this.takeout.pendingItems(row.id, 1)).length > 0;

    for (const item of items) {
      signal.throwIfAborted();
      const fileId = takeoutStableId(`${stagingSource.id}:${item.id}`);
      const name = path.posix.basename(item.path);
      // A run that stopped between recording the file and noting it here finds the file again.
      if (!(await this.takeout.hasFile(fileId))) {
        const free = await this.staging.freeBytes(directory);
        if (free < item.size + TAKEOUT_STAGING_RESERVE_BYTES) {
          if (await canDrain()) {
            return handled;
          }
          if (free <= TAKEOUT_STAGING_RESERVE_BYTES) {
            throw new TakeoutJobError('takeout_no_space', NO_SPACE);
          }
          // Only this file is too big for what is free: the smaller ones after it still get their turn.
          this.logger.warn(`Import connection ${connection.id}: ${item.path} does not fit in staging`);
          await this.repository.itemFailed(item.id, row.id, NO_SPACE);
          handled++;
          continue;
        }
        const destination = path.join(directory, fileId);
        let digest: StagedDigest;
        try {
          digest = await this.staging.stageRemote(
            (start) =>
              source.open(
                item.remoteId,
                { start, contentHash: item.contentHash ?? undefined, size: item.size },
                signal,
              ),
            item.size,
            destination,
            signal,
          );
        } catch (error) {
          if (signal.aborted || error instanceof RemoteSourceAuthError) {
            throw await this.sourceFailure(connection, signal, error, 'The source could not be read');
          }
          if (error instanceof RemoteSourceUnavailableError) {
            // Not this file's fault: it stays to do, and the job stops once what is staged is imported.
            if (await canDrain()) {
              return handled;
            }
            throw await this.sourceFailure(connection, signal, error, 'The source could not be read');
          }
          const reason =
            error instanceof RemoteSourceError || error instanceof TakeoutStagingError
              ? error.message.slice(0, 1000)
              : 'The file could not be downloaded';
          this.logger.warn(`Import connection ${connection.id}: ${item.path} was not downloaded: ${reason}`);
          await this.repository.itemFailed(item.id, row.id, reason);
          handled++;
          continue;
        }
        await this.takeout.recordFile({
          id: fileId,
          importId: row.id,
          sourceId: stagingSource.id,
          entryName: item.id,
          relativePath: item.path,
          folder: item.albumHint ?? '',
          name,
          kind: mimeTypes.isVideo(name) ? 'video' : 'image',
          path: destination,
          size: digest.size,
          checksum: digest.checksum,
          legacyChecksum: digest.legacyChecksum,
          modifiedAt: item.modifiedAt,
          metadata: null,
        });
      }
      // Outside the check above, so a stop between the two writes cannot leave a file with no item.
      await this.takeout.recordItem({
        id: fileId,
        importId: row.id,
        state: 'ready',
        metadata: {
          title: name,
          ...(item.caption && { description: item.caption }),
          ...(item.favourite && { favorite: true }),
        },
        sidecarId: null,
        candidates: [],
        albums: item.albumHint ? [item.albumHint] : [],
        warnings: [],
        locked: false,
      });
      if (!(await this.repository.itemStaged(item.id, row.id, fileId))) {
        this.logger.warn(`Import connection ${connection.id}: ${item.path} moved to a newer run`);
      }
      handled++;
    }
    return handled;
  }

  private async open(row: TakeoutImport): Promise<{ connection: ImportConnection; source: RemoteSource }> {
    const connection = row.connectionId ? await this.repository.getById(row.connectionId) : undefined;
    if (!connection) {
      throw new TakeoutJobError('import_connection_missing', 'This connection was removed', false);
    }
    try {
      const source = await openImportConnection(
        { crypto: this.crypto, config: this.config, repository: this.repository },
        connection,
      );
      return { connection, source };
    } catch (error) {
      throw await this.sourceFailure(connection, undefined, error, 'The source could not be opened');
    }
  }

  /**
   * What a failed read of the source becomes for the job. A stop asked for meanwhile is passed on as it
   * is. A refused sign-in marks the connection and is not retried. Anything else fails the job with the
   * source's own words when it chose them, and in general terms otherwise.
   */
  private async sourceFailure(
    connection: ImportConnection,
    signal: AbortSignal | undefined,
    error: unknown,
    fallback: string,
  ): Promise<unknown> {
    if (signal?.aborted || error instanceof TakeoutJobError) {
      return error;
    }
    if (error instanceof RemoteSourceAuthError) {
      await this.repository.setStatus(connection.id, IMPORT_CONNECTION_SIGN_IN_REQUIRED);
      this.logger.warn(`Import connection ${connection.id} needs a new sign-in`);
      return new TakeoutJobError('import_connection_sign_in_required', error.message.slice(0, 1000), false);
    }
    return new TakeoutJobError(
      'import_connection_source_failed',
      error instanceof RemoteSourceError ? error.message.slice(0, 1000) : fallback,
    );
  }
}
