import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { JobRepository } from 'src/repositories/job.repository.js';
import { AssetVisibility, JobName, JobStatus } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository as RealJobRepository } from 'src/repositories/job.repository.js';
import { LocationFillRepository } from 'src/repositories/location-fill.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { LocationFillService } from 'src/services/location-fill.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-964: locations proposed from history, applied through the ordinary location edit, and undone. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

const setup = () => {
  const { sut: assets, ctx } = newMediumService(AssetService, {
    database: db,
    real: [
      AssetRepository,
      DuplicateRepository,
      AssetEditRepository,
      AssetJobRepository,
      AlbumRepository,
      AccessRepository,
      PartnerRepository,
      PartnerOriginRepository,
      PersonRepository,
      SharedLinkAssetRepository,
      StackRepository,
      UserRepository,
      MapRepository,
      MediaOperationRepository,
      PhysicalFileRepository,
      ConfigRepository,
      SearchRepository,
      SystemMetadataRepository,
    ],
    mock: [
      EventRepository,
      LoggingRepository,
      RealJobRepository,
      StorageRepository,
      OcrRepository,
      WebsocketRepository,
    ],
  });
  ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  const jobs = ctx.getMock(RealJobRepository);
  jobs.queue.mockResolvedValue();
  jobs.queueAll.mockResolvedValue();
  const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoggingRepository;
  const queue = vi.fn();
  const sut = new LocationFillService(
    logger,
    { queue } as unknown as JobRepository,
    new LocationFillRepository(db),
    assets,
  );
  return { sut, assets, ctx, queue, jobs };
};

type Context = ReturnType<typeof setup>['ctx'];

/** The owner's history: a morning walk in Banff (UTC-6), two places ten minutes and about 220 m apart. */
const history = async (ownerId: string) => {
  const source = await db
    .insertInto('location_history_source')
    .values({ ownerId, fileName: 'walk.gpx', kind: 'gpx', importedAt: new Date(), pointCount: 3 })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('location_point')
    .values(
      [
        ['2024-07-01T15:00:00Z', 51.178, -115.571],
        ['2024-07-01T15:10:00Z', 51.176, -115.571],
        ['2024-07-01T17:00:00Z', 51.089, -115.359],
      ].map(([recordedAt, latitude, longitude]) => ({
        ownerId,
        sourceId: source.id,
        recordedAt: new Date(recordedAt as string),
        latitude: latitude as number,
        longitude: longitude as number,
      })),
    )
    .execute();
  return source.id;
};

/** A photo taken at `instant`; with no `timeZone` only its clock time (`local`, in UTC fields) is to be trusted. */
const photo = async (
  ctx: Context,
  ownerId: string,
  instant: string,
  options: { timeZone?: string | null; local?: string; latitude?: number; longitude?: number; locked?: boolean } = {},
) => {
  const { asset } = await ctx.newAsset({
    ownerId,
    fileCreatedAt: new Date(instant),
    localDateTime: new Date(options.local ?? instant),
    ...(options.locked ? { visibility: AssetVisibility.Locked } : {}),
  });
  await ctx.newExif({
    assetId: asset.id,
    timeZone: options.timeZone === undefined ? 'America/Edmonton' : options.timeZone,
    latitude: options.latitude ?? null,
    longitude: options.longitude ?? null,
  });
  return asset.id;
};

const exifOf = (assetId: string) =>
  db
    .selectFrom('asset_exif')
    .select(['latitude', 'longitude', 'city', 'lockedProperties'])
    .where('assetId', '=', assetId)
    .executeTakeFirstOrThrow();

const proposalsOf = async (sut: LocationFillService, auth: AuthDto, runId: string) => {
  const { days } = await sut.getProposals(auth, runId, { page: 1, size: 500 });
  return new Map(days.flatMap(({ proposals }) => proposals).map((proposal) => [proposal.assetId, proposal]));
};

describe(LocationFillService.name, () => {
  it('proposes within the chosen gap, never for a photo that has a location, and changes nothing yet', async () => {
    const { sut, ctx, queue } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    await history(user.id);

    const between = await photo(ctx, user.id, '2024-07-01T15:04:00Z');
    const fourBefore = await photo(ctx, user.id, '2024-07-01T14:56:00Z');
    const twentyBefore = await photo(ctx, user.id, '2024-07-01T14:40:00Z');
    const midday = await photo(ctx, user.id, '2024-07-01T16:20:00Z');
    const located = await photo(ctx, user.id, '2024-07-01T15:05:00Z', { latitude: 43.65, longitude: -79.38 });
    const locked = await photo(ctx, user.id, '2024-07-01T15:05:00Z', { locked: true });
    const trashed = await photo(ctx, user.id, '2024-07-01T15:05:00Z');
    await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', trashed).execute();

    const run = await sut.create(auth, { maxGapMinutes: 15 });
    expect(run).toMatchObject({ status: 'proposing', maxGapMinutes: 15, proposalCount: 0 });
    expect(queue).toHaveBeenCalledWith({ name: JobName.LocationFillPropose, data: { id: run.id } });
    await expect(sut.handlePropose({ id: run.id })).resolves.toBe(JobStatus.Success);

    await expect(sut.get(auth, run.id)).resolves.toMatchObject({
      status: 'ready',
      candidateCount: 4,
      proposalCount: 2,
      appliedCount: 0,
    });
    const proposals = await proposalsOf(sut, auth, run.id);
    expect(proposals.keys().toArray().toSorted()).toEqual([between, fourBefore].toSorted());
    expect(proposals.get(between)).toMatchObject({ method: 'interpolated', gapSeconds: 240, applied: false });
    expect(proposals.get(between)!.latitude).toBeCloseTo(51.1772, 6);
    expect(proposals.get(fourBefore)).toMatchObject({ method: 'nearest', gapSeconds: 240, latitude: 51.178 });
    // a place 40 minutes away is not within 15 minutes; one hour is
    expect(proposals.has(midday)).toBe(false);
    expect(proposals.has(twentyBefore)).toBe(false);
    for (const id of [located, locked, trashed]) {
      expect(proposals.has(id)).toBe(false);
    }
    // nothing has changed
    await expect(exifOf(between)).resolves.toMatchObject({ latitude: null, longitude: null });
    await expect(exifOf(located)).resolves.toMatchObject({ latitude: 43.65, longitude: -79.38 });

    // a wider gap finds more, and never joins places 20 km apart
    const wide = await sut.create(auth, { maxGapMinutes: 60 });
    await sut.handlePropose({ id: wide.id });
    const wider = await proposalsOf(sut, auth, wide.id);
    expect(wider.get(twentyBefore)).toMatchObject({ method: 'nearest', gapSeconds: 1200, latitude: 51.178 });
    expect(wider.get(midday)).toMatchObject({ method: 'nearest', gapSeconds: 2400, latitude: 51.089 });
    // the first run changed nothing, so the new one replaced it
    await expect(sut.get(auth, run.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('matches a photo with no time zone by the clock where its owner was', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    await history(user.id);
    // 09:04 on the camera's clock, no zone: in Banff that is 15:04 UTC
    const byClock = await photo(ctx, user.id, '2024-07-01T09:04:00Z', { timeZone: null });
    // 15:04 on the clock with no zone is not 15:04 UTC in Banff: no proposal
    const sameDigits = await photo(ctx, user.id, '2024-07-01T15:04:00Z', { timeZone: null });

    const run = await sut.create(auth, { maxGapMinutes: 15 });
    await sut.handlePropose({ id: run.id });

    const proposals = await proposalsOf(sut, auth, run.id);
    expect(proposals.get(byClock)).toMatchObject({ method: 'interpolated', gapSeconds: 240 });
    expect(proposals.has(sameDigits)).toBe(false);
  });

  it('applies through the location edit, and undo leaves a location changed by hand since', async () => {
    const { sut, assets, ctx, jobs } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    await history(user.id);
    const first = await photo(ctx, user.id, '2024-07-01T15:04:00Z');
    const second = await photo(ctx, user.id, '2024-07-01T14:56:00Z');
    const editedLater = await photo(ctx, user.id, '2024-07-01T15:09:00Z');
    const placedMeanwhile = await photo(ctx, user.id, '2024-07-01T15:02:00Z');
    const untouched = await photo(ctx, user.id, '2024-07-01T15:05:00Z', { latitude: 43.65, longitude: -79.38 });

    const run = await sut.create(auth, { maxGapMinutes: 15 });
    await sut.handlePropose({ id: run.id });
    // between the look and the apply its owner places one photo by hand
    await assets.updateAll(auth, { ids: [placedMeanwhile], latitude: 48.137, longitude: 11.575 });
    jobs.queueAll.mockClear();

    await expect(sut.undo(auth, run.id)).rejects.toBeInstanceOf(BadRequestException);
    await expect(sut.apply(auth, run.id, {})).resolves.toMatchObject({ status: 'applying' });
    await expect(sut.apply(auth, run.id, {})).rejects.toBeInstanceOf(ConflictException);
    await expect(sut.handleApply({ id: run.id })).resolves.toBe(JobStatus.Success);

    await expect(sut.get(auth, run.id)).resolves.toMatchObject({ status: 'applied', appliedCount: 3 });
    const applied = await exifOf(first);
    expect(applied.latitude).toBeCloseTo(51.1772, 6);
    expect(applied.lockedProperties).toEqual(expect.arrayContaining(['latitude', 'longitude']));
    await expect(exifOf(second)).resolves.toMatchObject({ latitude: 51.178, longitude: -115.571 });
    // the hand's choice and the photo that already had a location are as they were
    await expect(exifOf(placedMeanwhile)).resolves.toMatchObject({ latitude: 48.137, longitude: 11.575 });
    await expect(exifOf(untouched)).resolves.toMatchObject({ latitude: 43.65, longitude: -79.38 });
    // each filled photo has its sidecar written, as any location edit does
    const sidecars = jobs.queueAll.mock.calls
      .flatMap(([items]) => items)
      .filter((job) => job.name === JobName.SidecarWrite)
      .map((job) => (job.data as { id: string }).id);
    expect(sidecars.toSorted()).toEqual([first, second, editedLater].toSorted());
    expect((await proposalsOf(sut, auth, run.id)).get(first)).toMatchObject({ applied: true });

    // its owner then moves one of the filled photos by hand
    await assets.updateAll(auth, { ids: [editedLater], latitude: 51.4254, longitude: -116.1773 });

    await expect(sut.undo(auth, run.id)).resolves.toMatchObject({ status: 'undoing' });
    await expect(sut.handleUndo({ id: run.id })).resolves.toBe(JobStatus.Success);

    await expect(exifOf(first)).resolves.toMatchObject({ latitude: null, longitude: null });
    await expect(exifOf(second)).resolves.toMatchObject({ latitude: null, longitude: null });
    await expect(exifOf(editedLater)).resolves.toMatchObject({ latitude: 51.4254, longitude: -116.1773 });
    await expect(exifOf(placedMeanwhile)).resolves.toMatchObject({ latitude: 48.137, longitude: 11.575 });
    await expect(exifOf(untouched)).resolves.toMatchObject({ latitude: 43.65, longitude: -79.38 });
    // the one left alone still counts as holding the run's location
    await expect(sut.get(auth, run.id)).resolves.toMatchObject({ status: 'undone', appliedCount: 1 });
    await expect(sut.undo(auth, run.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('applies only the chosen photos, and the rest later', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    await history(user.id);
    const chosen = await photo(ctx, user.id, '2024-07-01T15:04:00Z');
    const other = await photo(ctx, user.id, '2024-07-01T14:56:00Z');
    const run = await sut.create(auth, { maxGapMinutes: 15 });
    await sut.handlePropose({ id: run.id });

    await sut.apply(auth, run.id, { assetIds: [chosen] });
    await sut.handleApply({ id: run.id });
    await expect(sut.get(auth, run.id)).resolves.toMatchObject({ status: 'applied', appliedCount: 1 });
    await expect(exifOf(other)).resolves.toMatchObject({ latitude: null });

    // a photo that is not in the run is nothing to apply
    await expect(sut.apply(auth, run.id, { assetIds: [factory.uuid()] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(sut.get(auth, run.id)).resolves.toMatchObject({ status: 'applied' });

    await sut.apply(auth, run.id, {});
    await sut.handleApply({ id: run.id });
    await expect(sut.get(auth, run.id)).resolves.toMatchObject({ appliedCount: 2 });
    await expect(exifOf(other)).resolves.toMatchObject({ latitude: 51.178 });
  });

  it('keeps runs, proposals and the history behind them to their owner', async () => {
    const { sut, assets, ctx } = setup();
    const { user } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    await ctx.newPartner({ sharedById: user.id, sharedWithId: partner.id });
    const auth = factory.auth({ user });
    const partnerAuth = factory.auth({ user: partner });
    await history(user.id);
    const filled = await photo(ctx, user.id, '2024-07-01T14:56:00Z');
    // the partner's own photo at the same moment is not placed by someone else's history
    const partners = await photo(ctx, partner.id, '2024-07-01T14:56:00Z');

    await expect(sut.create(partnerAuth, { maxGapMinutes: 15 })).rejects.toThrow('Add your location history first');
    const run = await sut.create(auth, { maxGapMinutes: 15 });
    await sut.handlePropose({ id: run.id });
    await sut.apply(auth, run.id, {});
    await sut.handleApply({ id: run.id });

    await expect(sut.getAll(partnerAuth)).resolves.toEqual([]);
    for (const read of [
      () => sut.get(partnerAuth, run.id),
      () => sut.getProposals(partnerAuth, run.id, { page: 1, size: 100 }),
      () => sut.apply(partnerAuth, run.id, {}),
      () => sut.undo(partnerAuth, run.id),
    ]) {
      await expect(read()).rejects.toBeInstanceOf(NotFoundException);
    }
    await expect(exifOf(partners)).resolves.toMatchObject({ latitude: null });
    // the filled location is an ordinary edit, so the partner's copy follows it as any location does (FL-326);
    // the owner's own row, like the history, is never read by the partner
    await expect(assets.get(partnerAuth, filled)).rejects.toThrow();
  });

  it('has nothing to propose without history in reach, and says so by an empty run', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    await history(user.id);
    await photo(ctx, user.id, '2023-01-01T12:00:00Z');
    const run = await sut.create(auth, { maxGapMinutes: 60, from: '2023-01-01T00:00:00Z', to: '2023-12-31T00:00:00Z' });
    await sut.handlePropose({ id: run.id });
    await expect(sut.get(auth, run.id)).resolves.toMatchObject({
      status: 'ready',
      candidateCount: 1,
      proposalCount: 0,
    });
    await expect(sut.apply(auth, run.id, {})).rejects.toThrow('Nothing to apply');
    await expect(sut.get(auth, run.id)).resolves.toMatchObject({ status: 'ready' });
    await expect(sut.getProposals(auth, run.id, { page: 1, size: 100 })).resolves.toEqual({
      total: 0,
      hasNextPage: false,
      days: [],
    });
  });
});
