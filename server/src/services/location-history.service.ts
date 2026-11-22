import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import path from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  LocationHistorySourceCreateDto,
  LocationHistorySourceResponseDto,
  LocationHistoryUploadCreateDto,
  LocationHistoryUploadResponseDto,
} from 'src/dtos/location-history.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import {
  HistoryFormatError,
  type HistoryPoint,
  type HistoryReport,
  parseHistoryFile,
} from 'src/location-history/parse.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import {
  LocationHistoryRepository,
  LocationHistoryStagingError,
} from 'src/repositories/location-history.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

/** FL-925: places are stored this many at a time. */
export const LOCATION_HISTORY_BATCH = 10_000;

type SourceRow = Awaited<ReturnType<LocationHistoryRepository['createSource']>>;

const iso = (date: Date | string | null) => (date ? new Date(date).toISOString() : null);

const toDto = (row: SourceRow): LocationHistorySourceResponseDto => ({
  id: row.id,
  fileName: row.fileName,
  kind: row.kind,
  createdAt: iso(row.createdAt)!,
  importedAt: iso(row.importedAt),
  pointCount: row.pointCount,
  firstAt: iso(row.firstAt),
  lastAt: iso(row.lastAt),
  error: row.error,
});

/**
 * FL-925: a person brings in the location history they already have (Google Timeline, GPX, OwnTracks, Dawarich)
 * so photos without a location can be given one later (FL-964). The file is uploaded in parts, read in the
 * background a place at a time, and removed; what stays is the list of places, private to its owner.
 *
 * Nothing here reads or changes a photo.
 */
@Injectable()
export class LocationHistoryService {
  constructor(
    private logger: LoggingRepository,
    private jobRepository: JobRepository,
    private repository: LocationHistoryRepository,
  ) {
    this.logger.setContext(LocationHistoryService.name);
  }

  async createUpload(auth: AuthDto, dto: LocationHistoryUploadCreateDto): Promise<LocationHistoryUploadResponseDto> {
    const id = await this.staged(() => this.repository.createUpload(auth.user.id, dto.size));
    return { id, receivedBytes: 0 };
  }

  async uploadChunk(
    auth: AuthDto,
    id: string,
    offset: number,
    bytes: Buffer,
  ): Promise<LocationHistoryUploadResponseDto> {
    if (bytes.length === 0) {
      throw new BadRequestException('An upload part cannot be empty');
    }
    const receivedBytes = await this.staged(() => this.repository.writeChunk(auth.user.id, id, offset, bytes));
    return { id, receivedBytes };
  }

  /** Read a finished upload in the background. The entry is listed at once, and fills in as the file is read. */
  async createSource(auth: AuthDto, dto: LocationHistorySourceCreateDto): Promise<LocationHistorySourceResponseDto> {
    // a browser sends a bare name; anything that looks like a path keeps only its last part
    const fileName = path.basename(dto.fileName.replaceAll('\\', '/')) || dto.fileName;
    const source = await this.repository.createSource(auth.user.id, fileName);
    try {
      await this.staged(() => this.repository.adoptUpload(auth.user.id, dto.uploadId, source.id));
    } catch (error) {
      await this.repository.deleteSource(auth.user.id, source.id);
      throw error;
    }
    await this.jobRepository.queue({ name: JobName.LocationHistoryImport, data: { id: source.id } });
    return toDto(source);
  }

  async getSources(auth: AuthDto): Promise<LocationHistorySourceResponseDto[]> {
    const rows = await this.repository.getSources(auth.user.id);
    return rows.map((row) => toDto(row));
  }

  /** Remove a file's history. Photos that were given a location from it keep that location. */
  async deleteSource(auth: AuthDto, id: string): Promise<void> {
    if (!(await this.repository.deleteSource(auth.user.id, id))) {
      throw new NotFoundException('Location history file not found');
    }
    await this.repository.removeStaged(auth.user.id, id);
  }

  @OnEvent({ name: 'UserDelete' })
  async onUserDelete({ id }: ArgOf<'UserDelete'>) {
    await this.repository.removeOwnerFiles(id);
  }

  @OnJob({ name: JobName.LocationHistoryImport, queue: QueueName.BackgroundTask })
  async handleImport({ id }: JobOf<JobName.LocationHistoryImport>): Promise<JobStatus> {
    const source = await this.repository.getSourceForImport(id);
    if (!source || source.importedAt) {
      // removed while it waited, or a second run of a file already read
      return JobStatus.Skipped;
    }
    const started = Date.now();
    const report: HistoryReport = { kind: null, skipped: 0 };
    let batch: HistoryPoint[] = [];
    let count = 0;
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    try {
      // a run that was cut short starts the file again
      await this.repository.deletePoints(id);
      for await (const point of parseHistoryFile(this.repository.stagedPath(source.ownerId, id), report)) {
        const time = point.recordedAt.getTime();
        first = Math.min(first, time);
        last = Math.max(last, time);
        batch.push(point);
        if (batch.length === LOCATION_HISTORY_BATCH) {
          count += batch.length;
          await this.repository.insertPoints(source, batch, count);
          batch = [];
        }
      }
      count += batch.length;
      await this.repository.insertPoints(source, batch, count);
      if (count === 0) {
        throw new HistoryFormatError('No places with a date and time were found in this file');
      }
      await this.repository.finishSource(id, {
        kind: report.kind,
        pointCount: count,
        firstAt: new Date(first),
        lastAt: new Date(last),
      });
    } catch (error) {
      const reason =
        error instanceof HistoryFormatError
          ? error.message
          : (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'The upload was lost; add the file again'
            : null;
      if (reason === null) {
        // the server's trouble, not the file's: the file stays and the job is tried again
        throw error;
      }
      await this.repository.deletePoints(id);
      await this.repository.failSource(id, reason);
      await this.repository.removeStaged(source.ownerId, id);
      this.logger.warn(`Location history ${id} could not be read: ${reason}`);
      return JobStatus.Failed;
    }
    await this.repository.removeStaged(source.ownerId, id);
    this.logger.log(
      `Location history ${id}: ${count} places (${report.kind}), ${report.skipped} left out, ${Date.now() - started} ms`,
    );
    return JobStatus.Success;
  }

  private async staged<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof LocationHistoryStagingError) {
        if (error.kind === 'missing') {
          throw new NotFoundException(error.message);
        }
        throw error.kind === 'offset' ? new ConflictException(error.message) : new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
