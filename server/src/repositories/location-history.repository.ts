import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HistoryPoint } from 'src/location-history/parse.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { getDiskUsage } from 'src/utils/disk-usage.js';

/** FL-925: the most one upload part holds, as for Takeout archives. */
export const LOCATION_HISTORY_CHUNK_BYTES = 8 * 1024 * 1024;
/** A whole Takeout location export is a few gigabytes at most. */
export const LOCATION_HISTORY_MAX_BYTES = 8 * 1024 * 1024 * 1024;
/** Uploads a person may have waiting at once; older ones are cleared after a day. */
export const LOCATION_HISTORY_MAX_UPLOADS = 10;
const UPLOAD_KEPT_MS = 24 * 60 * 60 * 1000;
/** Disk space an upload must leave free. */
const RESERVE_BYTES = 1024 * 1024 * 1024;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** The upload cannot go on as asked; the message is for the person. `resumeAt` is where to carry on from. */
export class LocationHistoryStagingError extends Error {
  constructor(
    message: string,
    public readonly kind: 'missing' | 'refused' | 'offset' = 'refused',
  ) {
    super(message);
  }
}

const sourceColumns = [
  'id',
  'ownerId',
  'kind',
  'fileName',
  'createdAt',
  'importedAt',
  'pointCount',
  'firstAt',
  'lastAt',
  'error',
] as const;

/**
 * FL-925: a person's location history: the files they imported, the places in them, and uploads on their way in.
 * Every read names the owner; nothing here is read for a partner, an administrator or a shared link.
 *
 * Uploads wait in `<media>/location-history/<owner>/` and are removed once read, so the history itself lives only
 * in the database.
 */
@Injectable()
export class LocationHistoryRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  private directory(ownerId: string) {
    if (!UUID.test(ownerId)) {
      throw new Error('Invalid staging owner');
    }
    return path.join(StorageCore.getMediaLocation(), 'location-history', ownerId);
  }

  private file(ownerId: string, id: string, extension: 'upload' | 'history' | 'size') {
    if (!UUID.test(id)) {
      throw new Error('Invalid staging identity');
    }
    return path.join(this.directory(ownerId), `${id}.${extension}`);
  }

  /** Where the file of a source waits to be read. */
  stagedPath(ownerId: string, sourceId: string) {
    return this.file(ownerId, sourceId, 'history');
  }

  /** Start an upload of `size` bytes. Uploads abandoned a day ago are cleared first. */
  async createUpload(ownerId: string, size: number): Promise<string> {
    const directory = this.directory(ownerId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let waiting = 0;
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.upload')) {
        continue;
      }
      const filePath = path.join(directory, name);
      const stats = await stat(filePath).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > UPLOAD_KEPT_MS) {
        await rm(filePath, { force: true });
        await rm(filePath.replace(/\.upload$/, '.size'), { force: true });
      } else if (stats) {
        waiting++;
      }
    }
    if (waiting >= LOCATION_HISTORY_MAX_UPLOADS) {
      throw new LocationHistoryStagingError('Finish the uploads already started before adding more');
    }
    const { available } = await getDiskUsage(directory);
    if (available < size + RESERVE_BYTES) {
      throw new LocationHistoryStagingError('There is not enough free space on the server for this file');
    }
    const id = randomUUID();
    // The declared size waits beside the upload, so a file cut short is never read as the whole history.
    await writeFile(this.file(ownerId, id, 'size'), String(size), { flag: 'wx', mode: 0o600 });
    const handle = await open(this.file(ownerId, id, 'upload'), 'wx', 0o600);
    await handle.close();
    return id;
  }

  /** The size declared when the upload started; null for an upload started before sizes were kept. */
  private async declaredSize(ownerId: string, uploadId: string): Promise<number | null> {
    const text = await readFile(this.file(ownerId, uploadId, 'size'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    const size = text === null ? Number.NaN : Number(text);
    return Number.isSafeInteger(size) && size >= 0 ? size : null;
  }

  /** Append a part at `offset`; sending a part already stored again is harmless. Returns the bytes stored. */
  async writeChunk(ownerId: string, uploadId: string, offset: number, bytes: Buffer): Promise<number> {
    const handle = await open(this.file(ownerId, uploadId, 'upload'), 'r+').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        throw new LocationHistoryStagingError('Upload not found', 'missing');
      }
      throw error;
    });
    try {
      const { size } = await handle.stat();
      if (offset + bytes.length <= size) {
        // A retried part must be the part already stored, or this is a different file.
        const existing = Buffer.alloc(bytes.length);
        let read = 0;
        while (read < bytes.length) {
          const result = await handle.read(existing, read, bytes.length - read, offset + read);
          if (result.bytesRead === 0) {
            break;
          }
          read += result.bytesRead;
        }
        if (read !== bytes.length || !existing.equals(bytes)) {
          throw new LocationHistoryStagingError('This is not the file that was being uploaded');
        }
        return size;
      }
      if (offset !== size) {
        throw new LocationHistoryStagingError(`Resume this upload at byte ${size}`, 'offset');
      }
      const declared = await this.declaredSize(ownerId, uploadId);
      if (size + bytes.length > LOCATION_HISTORY_MAX_BYTES || (declared !== null && size + bytes.length > declared)) {
        throw new LocationHistoryStagingError('This file is too large to be a location history');
      }
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written, offset + written);
        written += result.bytesWritten;
      }
      return size + bytes.length;
    } finally {
      await handle.close();
    }
  }

  /** Hand a finished upload to its source. Throws `missing` when there is no such upload. */
  async adoptUpload(ownerId: string, uploadId: string, sourceId: string) {
    const from = this.file(ownerId, uploadId, 'upload');
    const stats = await stat(from).catch(() => null);
    if (!stats) {
      throw new LocationHistoryStagingError('Upload not found', 'missing');
    }
    if (stats.size === 0) {
      throw new LocationHistoryStagingError('This file is empty');
    }
    const declared = await this.declaredSize(ownerId, uploadId);
    if (declared !== null && stats.size !== declared) {
      throw new LocationHistoryStagingError(`Resume this upload at byte ${stats.size}`, 'offset');
    }
    await rename(from, this.file(ownerId, sourceId, 'history'));
    await rm(this.file(ownerId, uploadId, 'size'), { force: true });
  }

  async removeStaged(ownerId: string, sourceId: string) {
    await rm(this.file(ownerId, sourceId, 'history'), { force: true });
  }

  /** Everything of an account that is still waiting on disk; its rows go with the account. */
  async removeOwnerFiles(ownerId: string) {
    await rm(this.directory(ownerId), { recursive: true, force: true });
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  createSource(ownerId: string, fileName: string) {
    return this.db
      .insertInto('location_history_source')
      .values({ ownerId, fileName })
      .returning(sourceColumns)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getSources(ownerId: string) {
    return this.db
      .selectFrom('location_history_source')
      .select(sourceColumns)
      .where('ownerId', '=', ownerId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }

  /** For the import job only, which is handed the id by the owner's own request. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getSourceForImport(id: string) {
    return this.db.selectFrom('location_history_source').select(sourceColumns).where('id', '=', id).executeTakeFirst();
  }

  /** Remove a file's entry and its places. Photos are not touched: they hold their own locations. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async deleteSource(ownerId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('location_history_source')
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deletePoints(sourceId: string) {
    await this.db.deleteFrom('location_point').where('sourceId', '=', sourceId).execute();
  }

  /** Store a batch of places and move the file's running count on, so its owner sees the import advance. */
  async insertPoints(source: { id: string; ownerId: string }, points: HistoryPoint[], pointCount: number) {
    if (points.length === 0) {
      return;
    }
    await this.db.transaction().execute(async (tx) => {
      await sql`
        insert into "location_point" ("ownerId", "sourceId", "recordedAt", "latitude", "longitude", "accuracyM")
        select ${source.ownerId}::uuid, ${source.id}::uuid, point.*
        from unnest(
          ${points.map((point) => point.recordedAt.toISOString())}::timestamptz[],
          ${points.map((point) => point.latitude)}::double precision[],
          ${points.map((point) => point.longitude)}::double precision[],
          ${points.map((point) => point.accuracyM)}::real[]
        ) as point
      `.execute(tx);
      await tx.updateTable('location_history_source').set({ pointCount }).where('id', '=', source.id).execute();
    });
  }

  async finishSource(id: string, result: { kind: string | null; pointCount: number; firstAt: Date; lastAt: Date }) {
    await this.db
      .updateTable('location_history_source')
      .set({ ...result, importedAt: new Date(), error: null })
      .where('id', '=', id)
      .execute();
  }

  async failSource(id: string, error: string) {
    await this.db
      .updateTable('location_history_source')
      .set({ error, pointCount: 0, firstAt: null, lastAt: null, importedAt: null })
      .where('id', '=', id)
      .execute();
  }
}
