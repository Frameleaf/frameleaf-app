import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { PhotoLocationScanState } from 'src/schema/tables/photo-locations.table.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { MlAdmissionRefusal } from 'src/enum.js';
import { PhotoLocationsService } from 'src/services/photo-locations.service.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { locationNoCharge } from 'src/utils/photo-locations.js';

const auth = { user: { id: randomUUID() } } as AuthDto;
const scan = (state?: PhotoLocationScanState) => ({
  id: randomUUID(),
  ownerId: auth.user.id,
  status: 'running',
  refresh: false,
  estimateId: randomUUID(),
  eligiblePhotos: 1,
  selectedPhotos: 1,
  estimatedMicros: 5000,
  billing: null,
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
  const quote = {
    estimateId: row.estimateId,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    currency: 'USD',
    unitPriceMicros: 5000,
    eligiblePhotos: 1,
    selectedPhotos: 1,
    remainingPhotos: 0,
    holdMicros: 5000,
    availableMicros: 1_000_000,
  };
  const repository = {
    latest: vi.fn().mockResolvedValue(row),
    claim: vi.fn().mockResolvedValue(row),
    active: vi.fn().mockResolvedValue(true),
    cleanupActive: vi.fn().mockResolvedValue(true),
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
    getEstimate: vi.fn().mockResolvedValue({
      expiresAt: new Date(quote.expiresAt),
      record: { quote, refresh: false, cloudUrl: row.cloudUrl, instanceId: row.instanceId, linkedAt: row.linkedAt },
    }),
    getByEstimate: vi.fn().mockResolvedValue(undefined),
    countEligible: vi.fn().mockResolvedValue(1),
    keepEstimate: vi.fn(),
    owner: vi.fn().mockResolvedValue({ id: auth.user.id, isAdmin: true }),
    adopt: vi.fn().mockResolvedValue(true),
    adoptCompleted: vi.fn().mockResolvedValue(true),
    finish: vi.fn().mockResolvedValue(undefined),
  };
  const spending = { spendPermission: vi.fn().mockResolvedValue({ canConfirm: true, reason: null }) };
  const database = { withLock: vi.fn().mockImplementation((_lock, callback) => callback()) };
  const logger = { setContext: vi.fn(), warn: vi.fn() };
  const service = new PhotoLocationsService(
    repository as never,
    {} as never,
    {} as never,
    database as never,
    {} as never,
    {} as never,
    {} as never,
    logger as never,
    spending as never,
  );
  const request = vi.fn();
  vi.spyOn(service as unknown as { gateway: () => Promise<unknown> }, 'gateway').mockResolvedValue({
    request,
    cloudUrl: row.cloudUrl,
    instanceId: row.instanceId,
    linkedAt: row.linkedAt,
  });
  return { row, repository, service, request, logger, quote, spending };
}

async function setupInput(row = scan()) {
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-location-input-'));
  vi.mocked(StorageCore.getMediaLocation).mockReturnValue(directory);
  const folder = join(directory, 'frameleaf', 'location-scans');
  await mkdir(folder, { recursive: true });
  return { ...setup(row), directory, path: join(folder, `${row.id}.json.gz`) };
}

afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(join(tmpdir(), 'frameleaf-location-tests-no-media'));
});

it('requires explicit owner consent and never starts a scan just by reading status', async () => {
  const { service, request, repository } = setup();
  repository.latest.mockResolvedValue(undefined);
  request.mockResolvedValue({ enabled: false, available: true });
  expect(await service.status(auth)).toEqual({ enabled: true, available: true, scan: null });
  await expect(service.start(auth, { consent: false } as never)).rejects.toThrow('Explicit owner permission');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(expect.anything(), '/v1/locations/status');
  expect(repository.create).not.toHaveBeenCalled();
  expect(repository.claim).not.toHaveBeenCalled();
});

it('permits an eligible owner to start a scan without server opt-in', async () => {
  const row = { ...scan({}), status: 'queued', total: 0 };
  const { service, request, repository, quote } = setup(row);
  repository.create.mockResolvedValue(row);
  request.mockResolvedValue(quote);

  expect(await service.start(auth, { consent: true, estimateId: quote.estimateId })).toMatchObject({
    enabled: true,
    available: true,
    scan: { id: row.id, status: 'queued', processed: 0 },
  });
  expect(repository.create).toHaveBeenCalledWith(
    auth.user.id,
    false,
    expect.objectContaining({ request }),
    quote,
    quote,
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(expect.anything(), '/v1/locations/estimates', expect.anything());
  expect(repository.claim).not.toHaveBeenCalled();
});

it('keeps unlicensed owners enabled but unavailable and refuses their estimates', async () => {
  const { service, request, repository } = setup();
  request.mockResolvedValue({ enabled: true, available: false });
  expect(await service.status(auth)).toMatchObject({ enabled: true, available: false });
  await expect(service.estimate(auth, { refresh: false, maxPhotos: 1 })).rejects.toThrow('A live Frameleaf licence');
  expect(repository.create).not.toHaveBeenCalled();
});

it('keeps the feature enabled when the server is not linked to Cloud', async () => {
  const { service, request, repository, quote } = setup();
  vi.mocked((service as unknown as { gateway: () => Promise<unknown> }).gateway).mockRejectedValue(
    new Error('Link this server to Frameleaf Cloud first'),
  );
  expect(await service.status(auth)).toMatchObject({ enabled: true, available: false });
  await expect(service.start(auth, { consent: true, estimateId: quote.estimateId })).rejects.toThrow(
    'Link this server',
  );
  expect(request).not.toHaveBeenCalled();
  expect(repository.create).not.toHaveBeenCalled();
});

it('quotes a capped eligible library without preparing or uploading any photo', async () => {
  const { service, request, repository, quote } = setup();
  repository.countEligible.mockResolvedValue(4);
  request.mockImplementation((_schema, path) =>
    Promise.resolve(
      path === '/v1/locations/status'
        ? { enabled: true, available: true }
        : {
            ...quote,
            eligiblePhotos: 4,
            selectedPhotos: 2,
            remainingPhotos: 2,
            holdMicros: 10_000,
            availableMicros: 9999,
          },
    ),
  );
  expect(await service.estimate(auth, { refresh: false, maxSpendMicros: 10_001 })).toMatchObject({
    eligiblePhotos: 4,
    selectedPhotos: 2,
    remainingPhotos: 2,
    estimatedMicros: 10_000,
    canStart: false,
    refusal: 'Add AI credit before starting this scan',
  });
  expect(request).toHaveBeenLastCalledWith(expect.anything(), '/v1/locations/estimates', {
    method: 'POST',
    body: { photoCount: 4, locale: 'en', refresh: false, maxSpendMicros: 10_001 },
  });
  expect(repository.keepEstimate).toHaveBeenCalledTimes(1);
  expect(repository.create).not.toHaveBeenCalled();
  expect(repository.freeze).not.toHaveBeenCalled();
  expect(repository.points).not.toHaveBeenCalled();
});

it('refuses an uncapped estimate and rejects expired quotes without creating a scan', async () => {
  const { service, request, repository, quote } = setup();
  await expect(service.estimate(auth, { refresh: false })).rejects.toThrow('Choose a photo or spending limit');
  repository.getEstimate.mockResolvedValue({ expiresAt: new Date(0), record: { quote } });
  await expect(service.start(auth, { estimateId: quote.estimateId, consent: true })).rejects.toThrow(
    'estimate expired',
  );
  expect(request).not.toHaveBeenCalled();
  expect(repository.create).not.toHaveBeenCalled();
});

it('rechecks spending permission and returns the original scan for a repeated confirmation', async () => {
  const { row, service, request, repository, quote, spending } = setup();
  request.mockResolvedValue(quote);
  spending.spendPermission.mockResolvedValue({ canConfirm: false, reason: 'monthly-cap' });
  await expect(service.start(auth, { estimateId: quote.estimateId, consent: true })).rejects.toThrow(
    'monthly AI spending limit',
  );
  expect(repository.create).not.toHaveBeenCalled();
  repository.getByEstimate.mockResolvedValue(row);
  request.mockClear();
  expect((await service.start(auth, { estimateId: quote.estimateId, consent: true })).scan?.id).toBe(row.id);
  expect(request).not.toHaveBeenCalled();
});

it('refuses a newly insufficient wallet before reserving or creating local work', async () => {
  const { service, request, repository, quote } = setup();
  request.mockResolvedValue({ ...quote, availableMicros: 4999 });
  await expect(service.start(auth, { estimateId: quote.estimateId, consent: true })).rejects.toMatchObject({
    status: 402,
  });
  expect(repository.create).not.toHaveBeenCalled();
});

it('rechecks revoked spending permission before Cloud admission without counting its own reservation twice', async () => {
  const { row, service, request, repository, spending, directory } = await setupInput({
    ...scan({}),
    status: 'queued',
  });
  try {
    repository.points
      .mockResolvedValueOnce([{ assetId: 'asset', itemKey: 'opaque', latitude: 49, longitude: -123, accuracyM: 5 }])
      .mockResolvedValue([]);
    spending.spendPermission.mockResolvedValue({ canConfirm: false, reason: 'monthly-cap' });
    await service.tick();
    expect(spending.spendPermission).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: row.ownerId }) }),
      0.005,
      expect.any(Date),
      { exactHold: true, excludeLocationScanId: row.id },
    );
    expect(request).not.toHaveBeenCalled();
    expect(repository.patch).toHaveBeenCalledWith(
      row.id,
      row.leaseToken,
      expect.objectContaining({ status: 'failed' }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('treats an authoritative admission credit refusal as failed and uncharged instead of retrying forever', async () => {
  const row = scan({
    sha256: 'a'.repeat(64),
    compressedBytes: 10,
    pointCount: 1,
    cloudEstimateId: randomUUID(),
    quoteExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  });
  const { service, request, repository } = setup(row);
  request.mockRejectedValue(
    new FrameleafCloudError(MlAdmissionRefusal.WalletInsufficient, 402, 'Insufficient AI credit'),
  );
  await service.tick();
  expect(repository.patch).toHaveBeenCalledWith(
    row.id,
    row.leaseToken,
    expect.objectContaining({
      status: 'failed',
      billing: locationNoCharge(),
      state: expect.objectContaining({ cleanupPending: true, cloudCreateAttempted: false }),
    }),
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it('adopts incremental results while running and accepts an empty unchanged completion cursor', async () => {
  const { row, service, request, repository } = setup();
  request.mockImplementation((_schema, path) =>
    Promise.resolve(
      String(path).includes('/results?')
        ? {
            scanId: row.id,
            algorithmVersion: 1,
            items: row.state.resultOffset ? [] : [{ itemKey: 'opaque', state: 'unmatched' }],
            nextOffset: 7,
            complete: false,
          }
        : {
            scanId: row.id,
            state: 'running',
            billing: {
              ...locationNoCharge(),
              heldMicros: 5000,
              checkedPhotos: 1,
              chargedMicros: null,
              releasedMicros: null,
              state: 'held',
            },
          },
    ),
  );
  await service.tick();
  await service.tick();
  expect(repository.adopt).toHaveBeenCalledTimes(1);
  expect(repository.adopt).toHaveBeenCalledWith(row.id, row.leaseToken, [{ itemKey: 'opaque', state: 'unmatched' }]);
  expect(row.state.resultOffset).toBe(7);
  expect(repository.finish).not.toHaveBeenCalled();
  expect(repository.patch).not.toHaveBeenCalledWith(
    row.id,
    row.leaseToken,
    expect.objectContaining({ status: 'paused' }),
  );
});

it('does not upload GPS coordinates while the Cloud credit hold is still pending', async () => {
  const { row, service, request } = setup();
  request.mockResolvedValue({
    scanId: row.id,
    state: 'uploading',
    uploadOffset: 0,
    billing: {
      ...locationNoCharge(),
      heldMicros: 5000,
      state: 'pending_hold',
      chargedMicros: null,
      releasedMicros: null,
    },
  });
  await service.tick();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1]).toBe(`/v1/locations/scans/${row.id}`);
});

it('keeps reconciling a cancelled hold and acknowledges only an authoritative final receipt', async () => {
  const row = { ...scan(), status: 'cancelled', state: { ...scan().state, cleanupPending: true } };
  const { service, request, repository } = setup(row);
  let reads = 0;
  request.mockImplementation((_schema, path) => {
    if (String(path).endsWith('/cancel') || String(path).endsWith('/ack')) return Promise.resolve({});
    if (!String(path).endsWith('/billing')) return Promise.resolve({ scanId: row.id, state: 'cancelled' });
    reads++;
    return Promise.resolve({
      scanId: row.id,
      state: 'cancelled',
      billing: {
        ...locationNoCharge(),
        heldMicros: 5000,
        state: reads === 1 ? 'settling' : 'released',
        chargedMicros: reads === 1 ? null : 0,
        releasedMicros: reads === 1 ? null : 5000,
      },
    });
  });
  await service.tick();
  expect(request.mock.calls.some(([, path]) => String(path).endsWith('/ack'))).toBe(false);
  expect(repository.patch).not.toHaveBeenCalledWith(row.id, row.leaseToken, { state: {} });
  await service.tick();
  expect(request.mock.calls.filter(([, path]) => String(path).endsWith('/ack'))).toHaveLength(1);
  expect(repository.patch).toHaveBeenCalledWith(row.id, row.leaseToken, {
    billing: expect.objectContaining({ state: 'released', chargedMicros: 0, releasedMicros: 5000 }),
  });
  expect(repository.patch).toHaveBeenCalledWith(row.id, row.leaseToken, { state: {} });
  expect(repository.adopt).not.toHaveBeenCalled();
});

it('drains already checked cancellation results before acknowledgement and resumes its completion cursor', async () => {
  const row = {
    ...scan(),
    status: 'cancelled',
    total: 2,
    estimatedMicros: 10_000,
    state: { ...scan().state, cleanupPending: true },
  };
  const { service, request, repository } = setup(row);
  const base = `/v1/locations/scans/${row.id}`;
  const billing = {
    ...locationNoCharge(),
    heldMicros: 10_000,
    checkedPhotos: 2,
    chargedMicros: 10_000,
    state: 'settled',
  };
  request.mockImplementation((_schema, path) => {
    if (path === `${base}/cancel`) {
      expect(repository.clearItems).not.toHaveBeenCalled();
      return Promise.resolve({});
    }
    if (path === base) return Promise.resolve({ scanId: row.id, state: 'cancelled', billing });
    if (path === `${base}/billing`) return Promise.resolve({ scanId: row.id, billing });
    if (path === `${base}/results?offset=0&limit=500`)
      return Promise.resolve({
        scanId: row.id,
        items: [{ itemKey: 'first', state: 'unmatched' }],
        nextOffset: 7,
        complete: false,
      });
    if (path === `${base}/results?offset=7&limit=500`)
      return Promise.resolve({
        scanId: row.id,
        items: [{ itemKey: 'second', state: 'unmatched' }],
        nextOffset: null,
        complete: true,
      });
    if (path === `${base}/ack`) {
      expect(repository.adoptCompleted).toHaveBeenCalledTimes(2);
      expect(repository.clearItems).not.toHaveBeenCalled();
      return Promise.resolve({});
    }
    throw new Error(`Unexpected Cloud request: ${path}`);
  });

  await service.tick();
  expect(row.state.resultOffset).toBe(7);
  expect(repository.clearItems).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([, path]) => String(path).endsWith('/ack'))).toBe(false);
  await service.tick();

  expect(repository.adopt).not.toHaveBeenCalled();
  expect(repository.adoptCompleted).toHaveBeenNthCalledWith(
    1,
    row.id,
    row.leaseToken,
    [{ itemKey: 'first', state: 'unmatched' }],
    2,
  );
  expect(repository.adoptCompleted).toHaveBeenNthCalledWith(
    2,
    row.id,
    row.leaseToken,
    [{ itemKey: 'second', state: 'unmatched' }],
    2,
  );
  expect(repository.clearItems).toHaveBeenCalledWith(row.id, row.leaseToken);
  expect(repository.patch).toHaveBeenCalledWith(row.id, row.leaseToken, { state: {} });
});

it('recovers the exact partial settlement after nine offline days and expired private scan data', async () => {
  const row = {
    ...scan(),
    status: 'cancelled',
    total: 2,
    estimatedMicros: 10_000,
    createdAt: new Date(Date.now() - 9 * 86_400_000),
    state: { ...scan().state, cleanupPending: true },
  };
  const { service, request, repository } = setup(row);
  const billing = {
    ...locationNoCharge(),
    heldMicros: 10_000,
    checkedPhotos: 1,
    chargedMicros: 5000,
    releasedMicros: 5000,
    state: 'settled',
  };
  request.mockImplementation((_schema, path) => {
    if (String(path).endsWith('/billing')) return Promise.resolve({ scanId: row.id, billing });
    throw new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, 410, 'Private scan expired');
  });

  await service.tick();

  expect(repository.patch).toHaveBeenCalledWith(row.id, row.leaseToken, { billing });
  expect(repository.patch).not.toHaveBeenCalledWith(row.id, row.leaseToken, { billing: locationNoCharge() });
  expect(repository.clearItems).toHaveBeenCalledWith(row.id, row.leaseToken);
  expect(repository.patch).toHaveBeenCalledWith(row.id, row.leaseToken, { state: {} });
  expect(repository.adoptCompleted).not.toHaveBeenCalled();
});

it('does not invent a zero charge when an attempted Cloud admission and its receipt are unknown', async () => {
  const row = {
    ...scan(),
    status: 'cancelled',
    state: { cloudCreateAttempted: true, cleanupPending: true },
    createdAt: new Date(Date.now() - 9 * 86_400_000),
  };
  const { service, request, repository } = setup(row);
  request.mockRejectedValue(new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, 404, 'Unknown scan'));

  await service.tick();

  expect(request.mock.calls.some(([, path]) => String(path).endsWith('/billing'))).toBe(true);
  expect(repository.patch).not.toHaveBeenCalledWith(row.id, row.leaseToken, { billing: locationNoCharge() });
  expect(repository.patch).not.toHaveBeenCalledWith(row.id, row.leaseToken, { state: {} });
});

it('does not restart a Cloud pause requiring cause correction or refill provider retries', async () => {
  const { row, service, request, repository } = setup();
  request.mockResolvedValue({
    scanId: row.id,
    state: 'paused',
    pauseReason: 'provider-rejected',
    uploadOffset: 10,
    compressedBytes: 10,
    counts: { total: 1, processed: 0, matched: 0, unmatched: 0 },
    billing: { ...locationNoCharge(), heldMicros: 5000, chargedMicros: null, releasedMicros: null, state: 'held' },
  });
  await service.tick();
  expect(request.mock.calls.some(([, path]) => String(path).endsWith('/start'))).toBe(false);
  expect(repository.patch).toHaveBeenCalledWith(row.id, row.leaseToken, expect.objectContaining({ status: 'paused' }));
});

it('refuses to send prepared coordinates after a photo privacy change', async () => {
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
        return Promise.resolve({
          scanId: row.id,
          state: 'uploading',
          uploadOffset: 0,
          billing: {
            ...locationNoCharge(),
            heldMicros: 5000,
            chargedMicros: null,
            releasedMicros: null,
            state: 'held',
          },
        });
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

it('expires old scans', async () => {
  const row = { ...scan(), createdAt: new Date(Date.now() - 8 * 86_400_000) };
  const { service, repository } = setup(row);
  await service.tick();
  expect(repository.patch).toHaveBeenCalledWith(
    row.id,
    row.leaseToken,
    expect.objectContaining({ status: 'failed', state: expect.objectContaining({ cleanupPending: true }) }),
  );
});

it('removes private mappings after a Cloud link change but keeps an unconfirmed financial receipt pending', async () => {
  const row = { ...scan(), status: 'completed', state: { ...scan().state, cleanupPending: true } };
  const { service, repository } = setup(row);
  vi.mocked((service as unknown as { gateway: () => Promise<unknown> }).gateway).mockRejectedValue(
    new ForbiddenException('The Frameleaf Cloud link changed'),
  );
  await service.tick();
  expect(repository.clearItems).toHaveBeenCalledWith(row.id, row.leaseToken);
  expect(repository.patch).not.toHaveBeenCalledWith(row.id, row.leaseToken, { state: {} });
});

it('recovers only the financial receipt after relinking the same Cloud instance', async () => {
  const row = { ...scan(), status: 'cancelled', state: { ...scan().state, cleanupPending: true } };
  const { service, request, repository } = setup(row);
  const billing = { ...locationNoCharge(), heldMicros: 5000, releasedMicros: 5000, state: 'released' };
  vi.mocked((service as unknown as { gateway: (ownerId: string, expected?: unknown) => Promise<unknown> }).gateway)
    .mockRejectedValueOnce(new ForbiddenException('The Frameleaf Cloud link changed'))
    .mockResolvedValue({ request, cloudUrl: row.cloudUrl, instanceId: row.instanceId, linkedAt: 'new-link' });
  request.mockResolvedValue({ scanId: row.id, billing });

  await service.tick();

  expect(request.mock.calls.map(([, path]) => path)).toEqual([`/v1/locations/scans/${row.id}/billing`]);
  expect(repository.patch).toHaveBeenCalledWith(row.id, row.leaseToken, { billing });
  expect(repository.patch).toHaveBeenCalledWith(row.id, row.leaseToken, { state: {} });
  expect(repository.adopt).not.toHaveBeenCalled();
  expect(repository.adoptCompleted).not.toHaveBeenCalled();
});

it.each([{ cloudUrl: 'https://another-cloud.invalid' }, { instanceId: randomUUID() }])(
  'does not recover old billing through a different Cloud binding: %j',
  async (change) => {
    const row = { ...scan(), status: 'cancelled', state: { ...scan().state, cleanupPending: true } };
    const { service, request, repository } = setup(row);
    vi.mocked((service as unknown as { gateway: (ownerId: string, expected?: unknown) => Promise<unknown> }).gateway)
      .mockRejectedValueOnce(new ForbiddenException('The Frameleaf Cloud link changed'))
      .mockResolvedValue({ request, cloudUrl: row.cloudUrl, instanceId: row.instanceId, ...change });

    await service.tick();

    expect(request).not.toHaveBeenCalled();
    expect(repository.patch).not.toHaveBeenCalledWith(row.id, row.leaseToken, { state: {} });
  },
);

it('does not adopt or acknowledge cancellation results after losing the cleanup lease', async () => {
  const row = { ...scan(), status: 'cancelled', state: { ...scan().state, cleanupPending: true } };
  const { service, request, repository } = setup(row);
  const billing = { ...locationNoCharge(), heldMicros: 5000, checkedPhotos: 1, chargedMicros: 5000, state: 'settled' };
  repository.cleanupActive.mockResolvedValueOnce(true).mockResolvedValue(false);
  request.mockImplementation((_schema, path) => {
    if (String(path).endsWith('/cancel')) return Promise.resolve({});
    if (String(path).includes('/results?'))
      return Promise.resolve({
        scanId: row.id,
        items: [{ itemKey: 'opaque', state: 'unmatched' }],
        nextOffset: null,
        complete: true,
      });
    return Promise.resolve({ scanId: row.id, state: 'cancelled', billing });
  });

  await service.tick();

  expect(repository.adoptCompleted).not.toHaveBeenCalled();
  expect(repository.clearItems).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([, path]) => String(path).endsWith('/ack'))).toBe(false);
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
