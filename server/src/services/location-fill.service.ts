import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  LocationFillApplyDto,
  LocationFillCreateDto,
  LocationFillProposalsQueryDto,
  LocationFillProposalsResponseDto,
  LocationFillRunResponseDto,
} from 'src/dtos/location-fill.dto.js';
import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { reportJobProgress } from 'src/queue/context.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { type FillCandidate, LocationFillRepository } from 'src/repositories/location-fill.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetService } from 'src/services/asset.service.js';
import {
  FILL_ZONE_SEARCH_HOURS,
  type FillProposal,
  ZoneLookup,
  proposeForLocalTime,
  proposeLocation,
} from 'src/utils/location-fill.js';

/** Photos a job reads, proposes for or changes before it says it is still moving. */
const PAGE = 200;
/** A stored coordinate and the one a run wrote are the same place within this (about 10 cm). */
const SAME_PLACE_DEGREES = 1e-6;

type RunRow = Awaited<ReturnType<LocationFillRepository['createRun']>>;

const iso = (date: Date | string | null) => (date ? new Date(date).toISOString() : null);

const toDto = (run: RunRow): LocationFillRunResponseDto => ({
  id: run.id,
  createdAt: iso(run.createdAt)!,
  status: run.status,
  maxGapMinutes: run.maxGapMinutes,
  from: iso(run.takenAfter),
  to: iso(run.takenBefore),
  candidateCount: run.candidateCount,
  proposalCount: run.proposalCount,
  appliedCount: run.appliedCount,
  appliedAt: iso(run.appliedAt),
  undoneAt: iso(run.undoneAt),
  error: run.error,
});

const samePlace = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= SAME_PLACE_DEGREES;

/**
 * FL-964: photos without a location get one from their owner's location history (FL-925) when the history has a
 * place close enough in time. A run first only proposes; its owner looks through the proposals and applies all or
 * some; whatever a run applied can be undone as a whole.
 *
 * - A photo that has a location is never proposed one, and never changed.
 * - Applying is an ordinary location edit (`AssetService.updateAll`): the database and the XMP sidecar change, the
 *   place names follow, partner copies follow. The original file never changes.
 * - Undo removes the location only where it is still the one the run wrote; a photo moved by hand since keeps the
 *   hand's choice.
 * - Partners see a filled location like any other. The history it came from stays its owner's alone.
 */
@Injectable()
export class LocationFillService {
  constructor(
    private logger: LoggingRepository,
    private jobRepository: JobRepository,
    private repository: LocationFillRepository,
    private assetService: AssetService,
  ) {
    this.logger.setContext(LocationFillService.name);
  }

  async create(auth: AuthDto, dto: LocationFillCreateDto): Promise<LocationFillRunResponseDto> {
    const ownerId = auth.user.id;
    if (!(await this.repository.hasHistory(ownerId))) {
      throw new BadRequestException('Add your location history first');
    }
    if (await this.repository.hasWorkingRun(ownerId)) {
      throw new ConflictException('Wait for the run already under way');
    }
    await this.repository.deleteIdleRuns(ownerId);
    const run = await this.repository.createRun({
      ownerId,
      maxGapMinutes: dto.maxGapMinutes,
      takenAfter: dto.from ? new Date(dto.from) : null,
      takenBefore: dto.to ? new Date(dto.to) : null,
    });
    await this.jobRepository.queue({ name: JobName.LocationFillPropose, data: { id: run.id } });
    return toDto(run);
  }

  async getAll(auth: AuthDto): Promise<LocationFillRunResponseDto[]> {
    const runs = await this.repository.getRuns(auth.user.id);
    return runs.map((run) => toDto(run));
  }

  async get(auth: AuthDto, id: string): Promise<LocationFillRunResponseDto> {
    return toDto(await this.findRun(auth, id));
  }

  async getProposals(
    auth: AuthDto,
    id: string,
    { page, size }: LocationFillProposalsQueryDto,
  ): Promise<LocationFillProposalsResponseDto> {
    const run = await this.findRun(auth, id);
    const rows = await this.repository.getProposals(run.id, (page - 1) * size, size);
    const days: LocationFillProposalsResponseDto['days'] = [];
    for (const row of rows.slice(0, size)) {
      const localDateTime = new Date(row.localDateTime).toISOString();
      const day = localDateTime.slice(0, 10);
      if (days.at(-1)?.day !== day) {
        days.push({ day, proposals: [] });
      }
      days.at(-1)!.proposals.push({
        assetId: row.assetId,
        latitude: row.latitude,
        longitude: row.longitude,
        method: row.method,
        gapSeconds: row.gapSeconds,
        localDateTime: localDateTime.slice(0, 19),
        applied: row.appliedAt !== null && row.undoneAt === null,
      });
    }
    return { total: run.proposalCount, hasNextPage: rows.length > size, days };
  }

  /** Give the run's proposals, or the chosen ones, to their photos. The work continues after the browser closes. */
  async apply(auth: AuthDto, id: string, dto: LocationFillApplyDto): Promise<LocationFillRunResponseDto> {
    const run = await this.repository.moveRun(auth.user.id, id, ['ready', 'applied', 'undone'], 'applying');
    if (!run) {
      await this.findRun(auth, id);
      throw new ConflictException('This run is busy; try again when it has finished');
    }
    if ((await this.repository.requestApply(id, dto.assetIds)) === 0) {
      await this.repository.updateRun(id, { status: run.appliedCount > 0 ? 'applied' : 'ready' });
      throw new BadRequestException('Nothing to apply');
    }
    await this.jobRepository.queue({ name: JobName.LocationFillApply, data: { id } });
    return toDto(run);
  }

  /** Take back every location the run gave that is still as the run left it. */
  async undo(auth: AuthDto, id: string): Promise<LocationFillRunResponseDto> {
    const run = await this.repository.moveRun(auth.user.id, id, ['applied'], 'undoing');
    if (!run) {
      const current = await this.findRun(auth, id);
      throw current.status === 'ready' || current.status === 'undone'
        ? new BadRequestException('Nothing to undo')
        : new ConflictException('This run is busy; try again when it has finished');
    }
    await this.jobRepository.queue({ name: JobName.LocationFillUndo, data: { id } });
    return toDto(run);
  }

  @OnJob({ name: JobName.LocationFillPropose, queue: QueueName.BackgroundTask })
  async handlePropose({ id }: JobOf<JobName.LocationFillPropose>): Promise<JobStatus> {
    const run = await this.repository.getRunForJob(id);
    if (run?.status !== 'proposing') {
      return JobStatus.Skipped;
    }
    return this.guarded(run, async () => {
      // a run that was cut short starts again
      await this.repository.deleteProposals(id);
      const zones = new ZoneLookup();
      const maxGapSeconds = run.maxGapMinutes * 60;
      let candidateCount = 0;
      let proposalCount = 0;
      let afterId: string | null = null;
      for (;;) {
        const candidates = await this.repository.getCandidates(run.ownerId, run, afterId, PAGE);
        if (candidates.length === 0) {
          break;
        }
        const proposals = [];
        for (const candidate of candidates) {
          const proposal = await this.propose(run.ownerId, candidate, maxGapSeconds, zones);
          if (proposal) {
            proposals.push({ runId: id, assetId: candidate.id, ...proposal });
          }
        }
        await this.repository.insertProposals(proposals);
        candidateCount += candidates.length;
        proposalCount += proposals.length;
        afterId = candidates.at(-1)!.id;
        await this.repository.updateRun(id, { candidateCount, proposalCount });
        reportJobProgress(candidateCount);
      }
      await this.repository.updateRun(id, { status: 'ready', candidateCount, proposalCount });
      this.logger.log(
        `Location fill ${id}: ${proposalCount} proposals for ${candidateCount} photos without a location`,
      );
    });
  }

  @OnJob({ name: JobName.LocationFillApply, queue: QueueName.BackgroundTask })
  async handleApply({ id }: JobOf<JobName.LocationFillApply>): Promise<JobStatus> {
    const run = await this.repository.getRunForJob(id);
    if (run?.status !== 'applying') {
      return JobStatus.Skipped;
    }
    return this.guarded(run, async () => {
      const auth = { user: { id: run.ownerId } } as AuthDto;
      let done = 0;
      let afterAssetId: string | null = null;
      for (;;) {
        const proposals = await this.repository.getToApply(id, afterAssetId, PAGE);
        if (proposals.length === 0) {
          break;
        }
        const current = await this.repository.getLocations(
          run.ownerId,
          proposals.map(({ assetId }) => assetId),
        );
        for (const { assetId, latitude, longitude } of proposals) {
          const now = current.get(assetId);
          // only a photo that still has no location at all: one given a place since the run looked is left alone
          if (now && now.latitude === null && now.longitude === null) {
            try {
              await this.assetService.updateAll(auth, { ids: [assetId], latitude, longitude });
              await this.repository.markProposal(id, assetId, { appliedAt: new Date(), undoneAt: null });
            } catch (error) {
              // one photo that cannot be changed now (Locked since, for one) does not stop the rest
              this.logger.warn(`Location fill ${id}: left ${assetId} as it is: ${error}`);
            }
          }
        }
        afterAssetId = proposals.at(-1)!.assetId;
        done += proposals.length;
        reportJobProgress(done);
      }
      const appliedCount = await this.repository.countApplied(id);
      await this.repository.updateRun(id, {
        status: appliedCount > 0 ? 'applied' : 'ready',
        appliedCount,
        appliedAt: new Date(),
        undoneAt: null,
      });
      this.logger.log(`Location fill ${id}: ${appliedCount} photos hold a location from this run`);
    });
  }

  @OnJob({ name: JobName.LocationFillUndo, queue: QueueName.BackgroundTask })
  async handleUndo({ id }: JobOf<JobName.LocationFillUndo>): Promise<JobStatus> {
    const run = await this.repository.getRunForJob(id);
    if (run?.status !== 'undoing') {
      return JobStatus.Skipped;
    }
    return this.guarded(run, async () => {
      const auth = { user: { id: run.ownerId } } as AuthDto;
      let done = 0;
      let restored = 0;
      let afterAssetId: string | null = null;
      for (;;) {
        const applied = await this.repository.getApplied(id, afterAssetId, PAGE);
        if (applied.length === 0) {
          break;
        }
        const current = await this.repository.getLocations(
          run.ownerId,
          applied.map(({ assetId }) => assetId),
        );
        for (const { assetId, latitude, longitude } of applied) {
          const now = current.get(assetId);
          // a location changed by hand since the run wrote it is the person's own choice, and stays
          if (now && samePlace(now.latitude, latitude) && samePlace(now.longitude, longitude)) {
            try {
              await this.assetService.updateAll(auth, { ids: [assetId], latitude: null, longitude: null });
              await this.repository.markProposal(id, assetId, { undoneAt: new Date() });
              restored++;
            } catch (error) {
              this.logger.warn(`Location fill ${id}: could not undo ${assetId}: ${error}`);
            }
          }
        }
        afterAssetId = applied.at(-1)!.assetId;
        done += applied.length;
        reportJobProgress(done);
      }
      await this.repository.updateRun(id, {
        status: 'undone',
        appliedCount: await this.repository.countApplied(id),
        undoneAt: new Date(),
      });
      this.logger.log(`Location fill ${id}: undone for ${restored} photos`);
    });
  }

  /** The place for one photo: by its exact moment when its time zone is known, else by its clock time. */
  private propose(
    ownerId: string,
    candidate: FillCandidate,
    maxGapSeconds: number,
    zones: ZoneLookup,
  ): Promise<FillProposal | null> {
    const around = (at: Date) => this.repository.getAround(ownerId, at, maxGapSeconds);
    if (candidate.timeZone) {
      const at = new Date(candidate.takenAt);
      return around(at).then(({ before, after }) => proposeLocation(at, before, after, maxGapSeconds));
    }
    const local = new Date(candidate.localDateTime);
    const reach = FILL_ZONE_SEARCH_HOURS * 3_600_000 + maxGapSeconds * 1000;
    return this.repository
      .getHourlySample(ownerId, new Date(local.getTime() - reach), new Date(local.getTime() + reach))
      .then((nearby) => proposeForLocalTime(local, nearby, zones, maxGapSeconds, around));
  }

  /**
   * Run one step of a run. If it fails the run says so and stops, so its owner can start another: it is never left
   * looking busy for ever.
   */
  private async guarded(run: RunRow, step: () => Promise<void>): Promise<JobStatus> {
    try {
      await step();
      return JobStatus.Success;
    } catch (error) {
      this.logger.error(`Location fill ${run.id} stopped while ${run.status}: ${error}`);
      const appliedCount = await this.repository.countApplied(run.id);
      await this.repository.updateRun(run.id, {
        // what was applied can still be undone
        status: appliedCount > 0 ? 'applied' : 'failed',
        appliedCount,
        error: 'Something went wrong before this finished. You can try again.',
      });
      return JobStatus.Failed;
    }
  }

  private async findRun(auth: AuthDto, id: string): Promise<RunRow> {
    const run = await this.repository.getRun(auth.user.id, id);
    if (!run) {
      throw new NotFoundException('Run not found');
    }
    return run;
  }
}
