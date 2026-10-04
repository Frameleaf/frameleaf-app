import { describe, expect, it, vi } from 'vitest';
import {
  STORAGE_MIGRATION_BACKGROUND_URL,
  STORAGE_MIGRATION_STATUS_URL,
  fetchStorageMigrationStatus,
  gettingReadyWaitsFor,
  runStorageMigrationInBackground,
  storageMigrationView,
  timeLeftParts,
  type StorageMigrationStatus,
} from '$lib/frameleaf/storage-migration';

const migrationStatus = (overrides: Partial<StorageMigrationStatus> = {}): StorageMigrationStatus => ({
  stage: 'checking',
  required: true,
  background: false,
  showInGettingReady: true,
  stages: {
    checking: { done: 1200, total: 48_210 },
    relinking: { done: 0, total: 0 },
    linking: { done: 0, total: 0 },
    trashing: { done: 0, total: 0 },
  },
  relinked: 0,
  toReview: 0,
  skipped: 0,
  bytesFreed: 0,
  estimatedSecondsLeft: null,
  startedAt: '2026-10-03T12:00:00.000Z',
  finishedAt: null,
  ...overrides,
});

describe('storage migration status', () => {
  it('reads the public status, and nothing from an older server', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(migrationStatus()));
    await expect(fetchStorageMigrationStatus(fetchFn)).resolves.toMatchObject({ stage: 'checking' });
    expect(fetchFn).toHaveBeenCalledWith(STORAGE_MIGRATION_STATUS_URL, expect.objectContaining({ cache: 'no-store' }));

    fetchFn.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(fetchStorageMigrationStatus(fetchFn)).resolves.toBeUndefined();
    fetchFn.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fetchStorageMigrationStatus(fetchFn)).resolves.toBeUndefined();
  });

  it('asks a visitor who is not an administrator to sign in before running it in the background', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(runStorageMigrationInBackground(fetchFn)).resolves.toEqual({ kind: 'sign-in' });
    expect(fetchFn).toHaveBeenCalledWith(STORAGE_MIGRATION_BACKGROUND_URL, expect.objectContaining({ method: 'POST' }));
    fetchFn.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(runStorageMigrationInBackground(fetchFn)).resolves.toEqual({ kind: 'sign-in' });
    fetchFn.mockResolvedValue(Response.json(migrationStatus({ background: true })));
    await expect(runStorageMigrationInBackground(fetchFn)).resolves.toMatchObject({ kind: 'ok' });
    fetchFn.mockResolvedValue(new Response(null, { status: 500 }));
    await expect(runStorageMigrationInBackground(fetchFn)).resolves.toEqual({ kind: 'error' });
  });

  it('waits only while the server says so', () => {
    expect(gettingReadyWaitsFor(undefined)).toBe(false);
    expect(gettingReadyWaitsFor(migrationStatus())).toBe(true);
    expect(gettingReadyWaitsFor(migrationStatus({ showInGettingReady: false }))).toBe(false);
  });
});

describe('storageMigrationView', () => {
  it('shows the running stage as X of Y and no Continue', () => {
    const view = storageMigrationView(migrationStatus());
    expect(view.kind).toBe('working');
    expect(view.canContinue).toBe(false);
    expect(view.tasks.map(({ id, status }) => [id, status])).toEqual([
      ['checking', 'running'],
      ['relinking', 'queued'],
      ['linking', 'queued'],
      ['trashing', 'queued'],
    ]);
    expect(view.tasks[0]).toMatchObject({ done: 1200, total: 48_210, percent: 2 });
    expect(view.percent).toBe(0);
  });

  it('counts finished stages into the overall progress', () => {
    const view = storageMigrationView(
      migrationStatus({
        stage: 'linking',
        stages: {
          checking: { done: 10, total: 10 },
          relinking: { done: 4, total: 4 },
          linking: { done: 50, total: 100 },
          trashing: { done: 0, total: 0 },
        },
        relinked: 3,
        toReview: 1,
      }),
    );
    expect(view.tasks.map(({ status }) => status)).toEqual(['done', 'done', 'running', 'queued']);
    expect(view.percent).toBe(62);
    expect(view).toMatchObject({ relinked: 3, toReview: 1 });
  });

  it('ends Done, or Finished with files to review', () => {
    expect(storageMigrationView(migrationStatus({ stage: 'done' }))).toMatchObject({
      kind: 'done',
      canContinue: true,
      percent: 100,
    });
    expect(storageMigrationView(migrationStatus({ stage: 'done', toReview: 3 }))).toMatchObject({
      kind: 'review',
      toReview: 3,
    });
  });

  it('lets the visitor continue once it runs in the background', () => {
    expect(storageMigrationView(migrationStatus({ background: true }))).toMatchObject({
      kind: 'background',
      canContinue: true,
    });
  });
});

describe('timeLeftParts', () => {
  it('rounds up to whole minutes', () => {
    expect(timeLeftParts(null)).toEqual({ kind: 'none' });
    expect(timeLeftParts(20)).toEqual({ kind: 'under-minute' });
    expect(timeLeftParts(90)).toEqual({ kind: 'minutes', minutes: 2 });
    expect(timeLeftParts(2 * 3600 + 600)).toEqual({ kind: 'hours', hours: 2, minutes: 10 });
  });
});
