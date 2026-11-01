import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { PhotoLocationScanState } from 'src/schema/tables/photo-locations.table.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { PhotoLocationsService } from 'src/services/photo-locations.service.js';

const auth = { user: { id: randomUUID() } } as AuthDto;
const scan = (state?: PhotoLocationScanState) => ({
  id: randomUUID(),
  ownerId: auth.user.id,
  status: 'running',
  refresh: false,
  total: 1,
  processed: 0,
  matched: 0,
  unmatched: 0,
  skipped: 0,
  failed: 0,
  error: null,
  reason: null,
  createdAt: new Date(),
  leaseToken: randomUUID(),
  instanceId: randomUUID(),
  cloudUrl: 'https://cloud.invalid',
  linkedAt: 'old-link',
  state: state ?? { sha256: 'a'.repeat(64), compressedBytes: 10, pointCount: 1, cloudCreated: true },
});

function setup(row = scan()) {
  const repository = {
    latest: vi.fn().mockResolvedValue(row),
    claim: vi.fn().mockResolvedValue(row),
    active: vi.fn().mockResolvedValue(true),
    patch: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    clearItems: vi.fn().mockResolvedValue(undefined),
    inputExists: vi.fn().mockResolvedValue(true),
    ownerActive: vi.fn().mockResolvedValue(true),
    inputStillEligible: vi.fn().mockResolvedValue(true),
    freeze: vi.fn().mockResolvedValue(1),
    points: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    renew: vi.fn(),
  };
  const logger = { setContext: vi.fn(), warn: vi.fn() };
  const service = new PhotoLocationsService(
    repository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    logger as never,
  );
  const request = vi.fn();
  vi.spyOn(service as unknown as { gateway: () => Promise<unknown> }, 'gateway').mockResolvedValue({ request });
  return { row, repository, service, request, logger };
}

async function setupInput(row = scan()) {
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-location-input-'));
  vi.mocked(StorageCore.getMediaLocation).mockReturnValue(directory);
  const folder = join(directory, 'frameleaf', 'location-scans');
  await mkdir(folder, { recursive: true });
  return { ...setup(row), directory, path: join(folder, `${row.id}.json.gz`) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(join(tmpdir(), 'frameleaf-location-tests-no-media'));
});

it('requires explicit owner consent and never starts a scan just by reading status', async () => {
  vi.stubEnv('FRAMELEAF_PHOTO_LOCATIONS_ENABLED', 'false');
  const { service, request, repository } = setup();
  expect(await service.status(auth)).toEqual(expect.objectContaining({ enabled: false, available: false }));
  await expect(service.start(auth, { consent: false } as never)).rejects.toThrow('Explicit owner permission');
  expect(request).not.toHaveBeenCalled();
  expect(repository.create).not.toHaveBeenCalled();
});

it('does not restart a Cloud pause requiring cause correction or refill provider retries', async () => {
  vi.stubEnv('FRAMELEAF_PHOTO_LOCATIONS_ENABLED', 'true');
  const { row, service, request, repository } = setup();
  request.mockResolvedValue({
    scanId: row.id,
    state: 'paused',
    pauseReason: 'provider-rejected',
    uploadOffset: 10,
    compressedBytes: 10,
    counts: { total: 1, processed: 0, matched: 0, unmatched: 0 },
  });
  await service.tick();
  expect(request.mock.calls.some(([, path]) => String(path).endsWith('/start'))).toBe(false);
  expect(repository.patch).toHaveBeenCalledWith(row.id, row.leaseToken, expect.objectContaining({ status: 'paused' }));
});

it('refuses to send prepared coordinates after a photo privacy change', async () => {
  vi.stubEnv('FRAMELEAF_PHOTO_LOCATIONS_ENABLED', 'true');
  const { row, service, request, repository } = setup();
  repository.inputStillEligible.mockResolvedValue(false);
  request.mockResolvedValue({
    scanId: row.id,
    state: 'paused',
    uploadOffset: 10,
    compressedBytes: 10,
    counts: { total: 1, processed: 0, matched: 0, unmatched: 0 },
  });
  await service.tick();
  expect(request).not.toHaveBeenCalled();
  expect(repository.patch).toHaveBeenCalledWith(
    row.id,
    row.leaseToken,
    expect.objectContaining({ status: 'failed', state: expect.objectContaining({ cleanupPending: true }) }),
  );
});

it('rejects a partial frozen snapshot even when a privacy switch preserves the eligible count', async () => {
  vi.stubEnv('FRAMELEAF_PHOTO_LOCATIONS_ENABLED', 'true');
  const row = { ...scan({}), status: 'queued', total: 2 };
  const { service, repository, request, directory, path } = await setupInput(row);
  try {
    const pointA = {
      assetId: '00000000-0000-4000-8000-000000000002',
      itemKey: 'opaque-a',
      latitude: 49,
      longitude: -123,
      accuracyM: 5,
    };
    const pointB = { ...pointA, assetId: '00000000-0000-4000-8000-000000000001', itemKey: 'opaque-b' };
    let visible = [pointA, pointB];
    repository.freeze.mockResolvedValue(visible.length);
    repository.points.mockImplementation((_scan, after: string) => {
      visible = after ? [pointB] : [pointA];
      return Promise.resolve(visible.filter((point) => point.assetId > after));
    });
    repository.inputStillEligible.mockImplementation((current) =>
      Promise.resolve(visible.length === current.state.pointCount),
    );

    await service.tick();

    const input = JSON.parse(gunzipSync(await readFile(path)).toString());
    expect(input.points).toEqual([{ itemKey: pointA.itemKey, latitude: 49, longitude: -123, accuracyM: 5 }]);
    expect(visible).toEqual([pointB]);
    expect(visible).toHaveLength(input.points.length);
    expect(repository.freeze).toHaveBeenCalledWith(row);
    expect(repository.inputStillEligible).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(repository.patch).toHaveBeenCalledWith(
      row.id,
      row.leaseToken,
      expect.objectContaining({ status: 'failed', state: expect.objectContaining({ cleanupPending: true }) }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not start Cloud processing when cancellation becomes visible during the final upload', async () => {
  vi.stubEnv('FRAMELEAF_PHOTO_LOCATIONS_ENABLED', 'true');
  const { row, service, repository, request, directory, path } = await setupInput();
  try {
    const input = gzipSync('synthetic GPS input');
    await writeFile(path, input);
    row.state.compressedBytes = input.length;
    const uploading = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<unknown>();
    const base = `/v1/locations/scans/${row.id}`;
    request.mockImplementation((_schema, requestPath) => {
      if (requestPath === base) {
        return Promise.resolve({ scanId: row.id, state: 'uploading', uploadOffset: 0 });
      }
      if (requestPath === `${base}/upload`) {
        uploading.resolve();
        return receipt.promise;
      }
      return Promise.reject(new Error(`Unexpected Cloud request: ${requestPath}`));
    });

    const ticking = service.tick();
    await uploading.promise;
    repository.active.mockResolvedValue(false);
    receipt.resolve({ scanId: row.id, uploadOffset: input.length, compressedBytes: input.length });
    await ticking;

    expect(request.mock.calls.map(([, requestPath]) => requestPath)).toEqual([base, `${base}/upload`]);
    expect(request.mock.calls[1][2]).toMatchObject({
      method: 'PUT',
      headers: { 'Upload-Offset': '0' },
      raw: { contentType: 'application/gzip', body: new Uint8Array(input) },
    });
    expect(repository.patch).not.toHaveBeenCalledWith(
      row.id,
      row.leaseToken,
      expect.objectContaining({ status: 'running' }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('expires old scans even when location enrichment is disabled', async () => {
  vi.stubEnv('FRAMELEAF_PHOTO_LOCATIONS_ENABLED', 'false');
  const row = { ...scan(), createdAt: new Date(Date.now() - 8 * 86_400_000) };
  const { service, repository } = setup(row);
  await service.tick();
  expect(repository.patch).toHaveBeenCalledWith(
    row.id,
    row.leaseToken,
    expect.objectContaining({ status: 'failed', state: expect.objectContaining({ cleanupPending: true }) }),
  );
});

it('removes local private mappings when the Cloud link changes instead of retrying cleanup forever', async () => {
  vi.stubEnv('FRAMELEAF_PHOTO_LOCATIONS_ENABLED', 'true');
  const row = { ...scan(), status: 'completed', state: { ...scan().state, cleanupPending: true } };
  const { service, repository } = setup(row);
  vi.mocked((service as unknown as { gateway: () => Promise<unknown> }).gateway).mockRejectedValue(
    new ForbiddenException('The Frameleaf Cloud link changed'),
  );
  await service.tick();
  expect(repository.clearItems).toHaveBeenCalledWith(row.id);
  expect(repository.patch).toHaveBeenCalledWith(row.id, row.leaseToken, { state: {} });
});

it('sweeps private input orphaned by an owner deletion without touching unrelated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-location-orphans-'));
  try {
    vi.mocked(StorageCore.getMediaLocation).mockReturnValue(directory);
    const folder = join(directory, 'frameleaf', 'location-scans');
    await mkdir(folder, { recursive: true });
    const orphan = join(folder, `${randomUUID()}.json.gz`);
    const unrelated = join(folder, 'unrelated.txt');
    await writeFile(orphan, 'synthetic GPS');
    await writeFile(unrelated, 'keep');
    const { service, repository } = setup();
    repository.claim.mockResolvedValue(undefined);
    repository.inputExists.mockResolvedValue(false);
    await service.tick();
    await expect(readFile(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(unrelated, 'utf8')).toBe('keep');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
