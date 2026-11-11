import { JobName } from 'src/enum.js';
import type { DateDoctorRepository } from 'src/repositories/date-doctor.repository.js';
import type { JobRepository } from 'src/repositories/job.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DateDoctorService } from 'src/services/date-doctor.service.js';
import { DateFindingCause, dateFromFileName, detectDateFindings } from 'src/utils/date-doctor.js';
import { FIXTURE_NOW, buildDateDoctorFixture, scoreFindings } from 'test/fixtures/date-doctor.fixture.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { vi } from 'vitest';

const now = new Date('2026-06-01T12:00:00Z');

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
    expect(dateFromFileName(fileName, now)).toEqual({ wall: new Date(wall), hasTime });
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
    ]);
    await expect(sut.getFindings(authStub.admin)).resolves.toEqual({
      total: 3,
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
      ],
    });
  });
});
