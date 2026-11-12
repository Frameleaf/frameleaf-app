import { BadRequestException } from '@nestjs/common';
import { vi } from 'vitest';
import type { AccessRepository } from 'src/repositories/access.repository.js';
import type { AccountEventRepository } from 'src/repositories/account-event.repository.js';
import type { DateDoctorRepository, DateFixCurrent } from 'src/repositories/date-doctor.repository.js';
import type { EventRepository } from 'src/repositories/event.repository.js';
import type { JobRepository } from 'src/repositories/job.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { AccountEventAction, JobName } from 'src/enum.js';
import { DateDoctorService } from 'src/services/date-doctor.service.js';
import { DateFindingCause, type DateScanRow, dateFromFileName, detectDateFindings } from 'src/utils/date-doctor.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { FIXTURE_NOW, buildDateDoctorFixture, scoreFindings } from 'test/fixtures/date-doctor.fixture.js';

const now = new Date('2026-06-01T12:00:00Z');

type FixDeps = [AccessRepository, AccountEventRepository, EventRepository, PartnerOriginRepository];

describe('dateFromFileName', () => {
  it.each([
    ['IMG_20230512_134501.jpg', '2023-05-12T13:45:01.000Z', true],
    ['PXL_20230512_134501123.MP.jpg', '2023-05-12T13:45:01.000Z', true],
    ['VID_20230512_134501.mp4', '2023-05-12T13:45:01.000Z', true],
    ['20230512_134501.jpg', '2023-05-12T13:45:01.000Z', true],
    ['Screenshot_20230512-134501_Chrome.jpg', '2023-05-12T13:45:01.000Z', true],
    ['Screenshot 2023-05-12 at 13.45.01.png', '2023-05-12T13:45:01.000Z', true],
    ['Screen Shot 2023-05-12 at 1.45.01 PM.png', '2023-05-12T13:45:01.000Z', true],
    ['Screen Shot 2023-05-12 at 12.05.09 AM.png', '2023-05-12T00:05:09.000Z', true],
    ['IMG-20230512-WA0001.jpg', '2023-05-12T00:00:00.000Z', false],
    ['VID-20230512-WA0042.mp4', '2023-05-12T00:00:00.000Z', false],
  ])('reads %s', (fileName, wall, hasTime) => {
    expect(dateFromFileName(fileName, now)).toEqual({
      wall: new Date(wall),
      hasTime,
      utc: fileName.startsWith('PXL_'),
    });
  });

  it.each([
    'DSC01234.JPG',
    'IMG_1234.HEIC',
    'IMG_20231345_134501.jpg', // month 13
    'IMG_20230230_101010.jpg', // 30 February
    'IMG_20230512_256001.jpg', // 25 o'clock
    'IMG_20990512_134501.jpg', // decades ahead
    'IMG_18990512_134501.jpg',
    'Screen Shot 2023-05-12 at 13.45.01 PM.png',
    'holiday 2023.jpg',
  ])('finds no date in %s', (fileName) => {
    expect(dateFromFileName(fileName, now)).toBeUndefined();
  });
});

describe('detectDateFindings, edge cases', () => {
  const row = (overrides: Partial<DateScanRow>): DateScanRow => ({
    id: 'photo',
    originalFileName: 'DSC00001.JPG',
    takenAt: new Date('2023-05-12T04:45:01Z'),
    localDateTime: new Date('2023-05-12T13:45:01Z'),
    timeZone: 'Asia/Tokyo',
    latitude: null,
    longitude: null,
    make: 'Sony',
    model: 'RX100',
    offsetTimeOriginal: null,
    offsetTime: null,
    dateLocked: false,
    zoneLocked: false,
    toCheck: false,
    ...overrides,
  });

  it('reads a Pixel name as the moment in UTC', () => {
    const [finding] = detectDateFindings(
      [
        row({
          originalFileName: 'PXL_20230512_044501123.jpg',
          takenAt: new Date('2031-06-01T00:00:00Z'),
          localDateTime: new Date('2031-06-01T09:00:00Z'),
          toCheck: true,
        }),
      ],
      now,
    );
    expect(finding).toMatchObject({
      cause: DateFindingCause.FutureDate,
      proposedDate: new Date('2023-05-12T04:45:01Z'),
    });
  });

  it('accepts any of the zones a place has', () => {
    // Ürümqi: the map gives Asia/Shanghai and Asia/Urumqi
    const urumqi = { latitude: 43.839319, longitude: 87.526148 };
    const takenAt = new Date('2023-05-12T06:00:00Z');
    expect(detectDateFindings([row({ ...urumqi, takenAt, timeZone: 'Asia/Urumqi' })], now)).toEqual([]);
    expect(detectDateFindings([row({ ...urumqi, takenAt, timeZone: 'Asia/Shanghai' })], now)).toEqual([]);
    expect(detectDateFindings([row({ ...urumqi, takenAt, timeZone: 'Europe/Paris' })], now)).toMatchObject([
      { cause: DateFindingCause.GpsZoneMismatch },
    ]);
  });

  it('treats a position out of range as no position, instead of failing the scan', () => {
    expect(
      detectDateFindings([row({ latitude: 91, longitude: 10 }), row({ id: 'b', longitude: 200, latitude: 1 })], now),
    ).toEqual([]);
  });
});

describe('detectDateFindings, on the FL-912 fixture', () => {
  const photos = buildDateDoctorFixture();
  const findings = detectDateFindings(photos, FIXTURE_NOW);
  const score = scoreFindings(photos, findings);

  it('holds 500 wrong photos and at least 500 clean ones', () => {
    expect(score.wrong).toBe(500);
    expect(score.clean).toBeGreaterThanOrEqual(500);
  });

  it.each(Object.values(DateFindingCause))('finds %s with the right proposal', (cause) => {
    const wrong = photos.filter((photo) => photo.expect?.cause === cause);
    const missed = score.missed.filter((photo) => photo.expect?.cause === cause);
    expect(wrong.length).toBeGreaterThan(0);
    expect(missed.map(({ originalFileName, expect }) => [originalFileName, expect])).toEqual([]);
  });

  it('finds at least 95% with the right proposal and flags at most 2% of the clean photos', () => {
    console.log(
      `FL-912 fixture: found ${score.found}/${score.wrong} (${((100 * score.found) / score.wrong).toFixed(1)}%), ` +
        `false positives ${score.falsePositives}/${score.clean} (${((100 * score.falsePositives) / score.clean).toFixed(1)}%)`,
    );
    expect(score.found / score.wrong).toBeGreaterThanOrEqual(0.95);
    expect(score.falsePositives / score.clean).toBeLessThanOrEqual(0.02);
  });

  it('never proposes a date or zone somebody set by hand', () => {
    const locked = new Set(photos.filter((photo) => photo.dateLocked || photo.zoneLocked).map(({ id }) => id));
    expect(locked.size).toBeGreaterThan(0);
    expect(findings.filter((finding) => locked.has(finding.assetId))).toEqual([]);
  });

  it('groups a shoot by camera and local day', () => {
    const drift = findings.filter((finding) => finding.cause === DateFindingCause.BurstDrift);
    expect(new Set(drift.map(({ groupKey }) => groupKey))).toEqual(
      new Set(
        ['2023-09-02', '2023-09-09', '2023-09-16', '2023-09-23', '2023-09-30'].map((day) => `Canon EOS R6|${day}`),
      ),
    );
  });
});

describe(DateDoctorService.name, () => {
  const setup = () => {
    const repository = {
      getOwnerIds: vi.fn(),
      getScanRows: vi.fn(),
      replaceFindings: vi.fn(),
      getFindings: vi.fn(),
    };
    const jobs = { queue: vi.fn(), queueAll: vi.fn() };
    const logger = { setContext: vi.fn(), log: vi.fn() };
    const sut = new DateDoctorService(
      logger as unknown as LoggingRepository,
      jobs as unknown as JobRepository,
      repository as unknown as DateDoctorRepository,
      ...([{}, {}, {}, {}] as unknown as FixDeps),
    );
    return { sut, repository, jobs };
  };

  it('queues a scan of the signed-in owner', async () => {
    const { sut, jobs } = setup();
    await sut.scan(authStub.admin);
    expect(jobs.queue).toHaveBeenCalledWith({ name: JobName.DateDoctorScan, data: { userId: authStub.admin.user.id } });
  });

  it('queues one scan per owner for the weekly run', async () => {
    const { sut, jobs, repository } = setup();
    repository.getOwnerIds.mockResolvedValue(['a', 'b']);
    await sut.handleQueueAll();
    expect(jobs.queueAll).toHaveBeenCalledWith([
      { name: JobName.DateDoctorScan, data: { userId: 'a' } },
      { name: JobName.DateDoctorScan, data: { userId: 'b' } },
    ]);
  });

  it('replaces the owner’s findings with what the scan found', async () => {
    const { sut, repository } = setup();
    const photos = buildDateDoctorFixture().slice(0, 40); // the future dates
    repository.getScanRows.mockResolvedValue(photos);
    await sut.handleScan({ userId: 'owner' });
    expect(repository.getScanRows).toHaveBeenCalledWith('owner');
    const [ownerId, findings] = repository.replaceFindings.mock.calls[0];
    expect(ownerId).toBe('owner');
    expect(findings).toHaveLength(40);
    expect(new Set(findings.map(({ cause }: { cause: string }) => cause))).toEqual(
      new Set([DateFindingCause.FutureDate]),
    );
  });

  it('groups findings by camera and day', async () => {
    const { sut, repository } = setup();
    const row = (assetId: string, groupKey: string) => ({
      assetId,
      cause: DateFindingCause.MissingZone,
      currentDate: new Date('2022-07-01T10:03:00Z'),
      currentZone: null,
      proposedDate: new Date('2022-07-01T08:03:00Z'),
      proposedZone: 'Europe/Paris',
      confidence: 0.8,
      groupKey,
      createdAt: new Date(),
    });
    repository.getFindings.mockResolvedValue([
      row('a', 'Nikon D90|2022-07-03'),
      row('b', 'Nikon D90|2022-07-03'),
      row('c', 'unknown|2022-07-01'),
      row('d', 'Brand Series|X|2022-06-30'),
    ]);
    await expect(sut.getFindings(authStub.admin)).resolves.toEqual({
      total: 4,
      groups: [
        expect.objectContaining({
          camera: 'Nikon D90',
          day: '2022-07-03',
          findings: [expect.objectContaining({ assetId: 'a' }), expect.objectContaining({ assetId: 'b' })],
        }),
        expect.objectContaining({
          camera: null,
          day: '2022-07-01',
          findings: [expect.objectContaining({ assetId: 'c', proposedDate: '2022-07-01T08:03:00.000Z' })],
        }),
        // a camera name may hold a `|`
        expect.objectContaining({ camera: 'Brand Series|X', day: '2022-06-30' }),
      ],
    });
  });
});

describe('DateDoctorService fixes (FL-930)', () => {
  const owner = authStub.admin;
  const current = (assetId: string, overrides: Partial<DateFixCurrent> = {}): DateFixCurrent => ({
    assetId,
    takenAt: new Date('2022-07-01T10:03:00Z'),
    localDateTime: new Date('2022-07-01T10:03:00Z'),
    dateTimeOriginal: new Date('2022-07-01T10:03:00Z'),
    timeZone: null,
    locked: false,
    earlier: null,
    ...overrides,
  });

  const setup = (owned: string[] = ['a', 'b']) => {
    const repository = {
      getProposals: vi.fn().mockResolvedValue([]),
      getCurrent: vi.fn().mockResolvedValue([]),
      applyFixes: vi.fn(),
      undoBatch: vi.fn(),
      pruneBatches: vi.fn().mockResolvedValue(0),
    };
    const jobs = { queue: vi.fn(), queueAll: vi.fn() };
    const access = { asset: { checkOwnerAccess: vi.fn().mockResolvedValue(new Set(owned)) } };
    const accountEvents = { create: vi.fn() };
    const events = { emit: vi.fn() };
    const partnerOrigin = { markOverridden: vi.fn(), getIdsWithFollowers: vi.fn().mockResolvedValue([]) };
    const logger = { setContext: vi.fn(), log: vi.fn(), error: vi.fn() };
    const sut = new DateDoctorService(
      logger as unknown as LoggingRepository,
      jobs as unknown as JobRepository,
      repository as unknown as DateDoctorRepository,
      ...([access, accountEvents, events, partnerOrigin] as unknown as FixDeps),
    );
    return { sut, repository, jobs, access, accountEvents, events, partnerOrigin };
  };
  const batch = { id: 'batch', userId: owner.user.id, count: 2, createdAt: now, undoneAt: null };

  it('previews a proposal: its date and zone, the clock time in that zone', async () => {
    const { sut, repository } = setup(['a']);
    repository.getProposals.mockResolvedValue([
      { assetId: 'a', proposedDate: new Date('2022-07-01T08:03:00Z'), proposedZone: 'Europe/Paris' },
    ]);
    repository.getCurrent.mockResolvedValue([current('a')]);

    await expect(
      sut.preview(owner, { findings: [{ assetId: 'a', cause: DateFindingCause.MissingZone }] }),
    ).resolves.toEqual({
      items: [
        {
          assetId: 'a',
          previousDate: '2022-07-01T10:03:00.000Z',
          previousZone: null,
          newDate: '2022-07-01T08:03:00.000Z',
          newZone: 'Europe/Paris',
        },
      ],
    });
    expect(repository.getCurrent).toHaveBeenCalledWith(owner.user.id, ['a']);
    expect(repository.applyFixes).not.toHaveBeenCalled();
  });

  it('keeps the clock time shown when a selection gets a zone, and moves it by the shift', async () => {
    const { sut, repository } = setup();
    repository.getCurrent.mockResolvedValue([current('a'), current('b', { timeZone: 'UTC' })]);

    const { items } = await sut.preview(owner, { assetIds: ['a', 'b'], timeZone: 'Asia/Tokyo', shiftMinutes: 60 });

    // 11:03 on the camera's clock in Tokyo is 02:03 UTC
    expect(items.map(({ newDate, newZone }) => ({ newDate, newZone }))).toEqual([
      { newDate: '2022-07-01T02:03:00.000Z', newZone: 'Asia/Tokyo' },
      { newDate: '2022-07-01T02:03:00.000Z', newZone: 'Asia/Tokyo' },
    ]);
  });

  it('shifts a selection without a zone, keeping its own', async () => {
    const { sut, repository } = setup(['a']);
    repository.getCurrent.mockResolvedValue([current('a', { timeZone: 'Europe/Paris' })]);

    const { items } = await sut.preview(owner, { assetIds: ['a'], shiftMinutes: -90 });

    expect(items).toEqual([expect.objectContaining({ newDate: '2022-07-01T08:33:00.000Z', newZone: 'Europe/Paris' })]);
  });

  it('refuses photos the caller does not own, a partner’s copy included, before reading or writing anything', async () => {
    const { sut, repository } = setup(['a']);

    await expect(sut.apply(owner, { assetIds: ['a', 'partner-copy'], shiftMinutes: 5 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.getCurrent).not.toHaveBeenCalled();
    expect(repository.applyFixes).not.toHaveBeenCalled();
  });

  it('keeps the values from before an earlier fix still in place', async () => {
    const { sut, repository } = setup(['a']);
    const earlier = {
      previousDate: null,
      previousZone: null,
      previousTakenAt: new Date('2000-01-01T00:00:00Z'),
      previousLocalDateTime: new Date('2000-01-01T00:00:00Z'),
      previousLocked: false,
    };
    repository.getCurrent.mockResolvedValue([current('a', { timeZone: 'Europe/Paris', locked: true, earlier })]);
    repository.applyFixes.mockResolvedValue({ batch, assetIds: ['a'] });

    await sut.apply(owner, { assetIds: ['a'], shiftMinutes: 10 });

    expect(repository.applyFixes).toHaveBeenCalledWith(owner.user.id, [
      expect.objectContaining({
        ...earlier,
        currentTakenAt: new Date('2022-07-01T10:03:00Z'),
        newZone: 'Europe/Paris',
      }),
    ]);
  });

  it('applies: rewrites sidecars, tells copies following the photos, refreshes timelines and logs the count', async () => {
    const { sut, repository, jobs, events, accountEvents, partnerOrigin } = setup();
    repository.getCurrent.mockResolvedValue([current('a'), current('b')]);
    repository.applyFixes.mockResolvedValue({ batch, assetIds: ['a', 'b'] });
    partnerOrigin.getIdsWithFollowers.mockResolvedValue(['a']);

    await expect(sut.apply(owner, { assetIds: ['a', 'b'], timeZone: 'Europe/Paris' })).resolves.toEqual({
      id: 'batch',
      count: 2,
      createdAt: now.toISOString(),
      undoneAt: null,
      undoUntil: '2026-07-01T12:00:00.000Z',
    });
    expect(partnerOrigin.markOverridden).toHaveBeenCalledWith('asset', ['a', 'b'], ['dateTimeOriginal'], owner.user.id);
    expect(jobs.queueAll).toHaveBeenCalledWith([
      { name: JobName.PartnerPropagate, data: { kind: 'asset', sourceId: 'a', fields: ['dateTimeOriginal'] } },
    ]);
    expect(jobs.queueAll).toHaveBeenCalledWith([
      { name: JobName.SidecarWrite, data: { id: 'a' } },
      { name: JobName.SidecarWrite, data: { id: 'b' } },
    ]);
    expect(events.emit).toHaveBeenCalledWith('AssetsChanged', { assetIds: ['a', 'b'] });
    expect(accountEvents.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: AccountEventAction.DatesFixed, detail: '2' }),
    );
  });

  it('says there is nothing to fix when no photo would change', async () => {
    const { sut, repository } = setup(['a']);
    repository.getCurrent.mockResolvedValue([current('a', { timeZone: 'UTC' })]);

    await expect(sut.apply(owner, { assetIds: ['a'], timeZone: 'UTC' })).rejects.toThrow('Nothing to fix');
    expect(repository.applyFixes).not.toHaveBeenCalled();
  });

  it('undoes: the sidecar gets the restored date, and a date nobody set by hand is read from the file again', async () => {
    const { sut, repository, jobs } = setup();
    repository.undoBatch.mockResolvedValue({
      batch: { ...batch, undoneAt: now },
      restored: [
        { assetId: 'a', previousLocked: false },
        { assetId: 'b', previousLocked: true },
      ],
      alreadyUndone: false,
    });

    await expect(sut.undo(owner, 'batch')).resolves.toEqual(
      expect.objectContaining({ undoneAt: now.toISOString(), restored: 2 }),
    );
    expect(repository.undoBatch).toHaveBeenCalledWith(owner.user.id, 'batch', expect.any(Date));
    expect(jobs.queueAll).toHaveBeenCalledWith([
      { name: JobName.SidecarWrite, data: { id: 'a', releaseDateLock: true } },
      { name: JobName.SidecarWrite, data: { id: 'b' } },
    ]);
  });

  it('refuses to undo another person’s batch, an old one or one already undone', async () => {
    const { sut, repository } = setup();
    repository.undoBatch.mockResolvedValue(undefined);
    await expect(sut.undo(owner, 'batch')).rejects.toThrow('Batch not found');

    repository.undoBatch.mockResolvedValue({ batch: { ...batch, undoneAt: now }, restored: [], alreadyUndone: true });
    await expect(sut.undo(owner, 'batch')).rejects.toThrow('Already undone');
  });

  it('removes batches older than 30 days each night', async () => {
    const { sut, repository } = setup();
    await sut.onNightlyDatabaseCleanup();
    const [before] = repository.pruneBatches.mock.calls[0];
    expect(Date.now() - before.getTime()).toBeGreaterThanOrEqual(30 * 24 * 3_600_000 - 1000);
  });
});
