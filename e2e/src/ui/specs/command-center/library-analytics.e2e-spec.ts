import { faker } from '@faker-js/faker';
import { BrowserContext, expect, Page, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * Library analytics (FL-79), the Sept 24 dashboard (`AnalyticsDashboard.jsx`) against a mocked
 * `GET /analytics`: the hero, the breakdown panels adding up to the report total, catch-all rows
 * last, the hidden-items note, people and places only for the owner's own scope, and the daily
 * heatmap's exact-count table. Also the area directories as grouped lists (FL-71, FL-10).
 */
const ownerId = '11111111-1111-4111-8111-111111111111';
const scopes = [
  { value: 'all', kind: 'host', label: '', userId: null, libraryId: null, removed: false },
  { value: `account:${ownerId}`, kind: 'account', label: 'Taylor', userId: ownerId, libraryId: null, removed: false },
];

const PUNCH: Record<string, number> = { '1:9': 50, '6:18': 30, '7:10': 20 };

const insights = (hiddenItems: number, owner: boolean) => ({
  hiddenItems,
  capturesByYear: [
    { year: 2019, count: 10 },
    { year: 2024, count: 40 - hiddenItems },
    { year: 2026, count: 50 },
  ],
  punchcard: Array.from({ length: 168 }, (_, index) => {
    const weekday = Math.floor(index / 24) + 1;
    const hour = index % 24;
    const count = PUNCH[`${weekday}:${hour}`] ?? 0;
    return { weekday, hour, count: weekday === 1 && hour === 9 ? count - hiddenItems : count };
  }),
  lenses: [
    { name: 'iPhone 16 Pro back camera', kind: 'named', count: 60 - hiddenItems },
    { name: null, kind: 'other', count: 10 },
    { name: null, kind: 'unknown', count: 30 },
  ],
  focalLengths: [
    { key: '0-16', count: 5 },
    { key: '17-28', count: 50 - hiddenItems },
    { key: '29-40', count: 10 },
    { key: '41-70', count: 5 },
    { key: '71-135', count: 0 },
    { key: '136-300', count: 0 },
    { key: '301+', count: 0 },
    { key: 'unknown', count: 30 },
  ],
  photoFormats: [
    { key: 'HEIC', count: 60 - hiddenItems },
    { key: 'JPEG', count: 20 },
    { key: 'RAW', count: 5 },
    { key: 'PNG', count: 3 },
    { key: 'OTHER', count: 2 },
  ],
  videoResolutions: [
    { key: '4K', count: 4 },
    { key: '1080p', count: 5 },
    { key: '720p', count: 0 },
    { key: 'SD', count: 0 },
    { key: 'unknown', count: 1 },
  ],
  orientation: [
    { key: 'landscape', count: 50 - hiddenItems },
    { key: 'portrait', count: 40 },
    { key: 'square', count: 5 },
    { key: 'panorama', count: 2 },
    { key: 'unknown', count: 3 },
  ],
  livePhotos: 12,
  hdr: { probedVideos: 8, hdrVideos: 3, dolbyVisionVideos: 1 },
  coverage: { facesChecked: 90 - hiddenItems, searchIndexed: 95 - hiddenItems },
  peopleAndPlaces: owner
    ? {
        faces: 70,
        itemsWithFaces: 40,
        itemsWithoutFaces: 60 - hiddenItems,
        namedPeople: 3,
        pets: 1,
        topPeople: [
          { id: faker.string.uuid(), name: 'Emma', count: 25 },
          { id: faker.string.uuid(), name: 'Jamie', count: 15 },
        ],
        geotagged: 60,
        countries: 2,
        cities: 3,
        places: [
          { name: 'Lisbon', kind: 'named', count: 20 },
          { name: 'Banff', kind: 'named', count: 30 },
          { name: null, kind: 'other', count: 10 },
          { name: null, kind: 'unknown', count: 40 - hiddenItems },
        ],
      }
    : null,
  records: {
    oldestCapture: { date: '2019-06-14', name: owner ? 'IMG_0001.JPG' : null },
    largestFile: { bytes: 3 * 1024 ** 3, name: owner ? 'Recital.mov' : null },
    longestVideo: { durationMs: 6_130_000, name: owner ? 'Recital.mov' : null },
    videoDurationMs: 7_200_000,
    videoHours: 2,
  },
});

const report = (scope: string, hiddenItems: number) => {
  const owner = scope !== 'all';
  return {
    scope,
    scopeKind: owner ? 'account' : 'host',
    scopeLabel: owner ? 'Taylor' : '',
    range: 'year',
    from: '2026-09-13',
    through: '2026-09-19',
    generatedAt: '2026-09-19T12:00:00.000Z',
    definitions: [],
    summary: {
      items: 100,
      photos: 90,
      videos: 10,
      raw: 5,
      files: 104,
      unmeasuredFiles: 0,
      logicalBytes: 10_000,
      uploadedLogicalBytes: 7000,
      externalLogicalBytes: 3000,
      physicalBytes: 8000,
      uploadedPhysicalBytes: 5000,
      externalPhysicalBytes: 3000,
      savedBytes: 2000,
      duplicateReferences: 4,
    },
    host: {
      state: 'measured',
      observedAt: '2026-09-19T12:00:00.000Z',
      volumeUsedBytes: 600_000,
      capacityBytes: 1_000_000,
      freeBytes: 400_000,
      breakdown: owner
        ? null
        : {
            originalsBytes: 300_000,
            previewsBytes: 100_000,
            encodedVideoBytes: 50_000,
            onOtherDisk: [],
            generatedObservedAt: '2026-09-19T00:05:00.000Z',
            databaseBytes: 30_000,
            otherBytes: 120_000,
            exceedsUsed: false,
          },
    },
    history: {
      state: 'measured',
      lastObservedAt: '2026-09-19T00:05:00.000Z',
      staleAfterHours: 36,
      dayRetentionDays: 120,
      weekRetentionDays: 800,
    },
    series: [
      {
        key: '2026-09-14',
        from: '2026-09-14',
        through: '2026-09-19',
        partial: true,
        photos: 3,
        videos: 1,
        completed: owner ? null : 9,
        failed: owner ? null : 1,
        items: 100,
        logicalBytes: 10_000,
        physicalBytes: 8000,
        observedAt: '2026-09-19T00:05:00.000Z',
      },
    ],
    days: ['13', '14', '15', '16', '17', '18', '19'].map((day) => ({
      date: `2026-09-${day}`,
      captured: day === '15' ? 2 : day === '18' ? 5 : 0,
      uploaded: day === '18' ? 4 : 0,
    })),
    cameras: [
      { name: 'Apple iPhone 16 Pro', kind: 'model', count: 80 - hiddenItems },
      { name: null, kind: 'unknown', count: 20 },
    ],
    metadata: [
      { field: 'captureDate', present: 98, missing: 2, total: 100 },
      { field: 'location', present: 60, missing: 40, total: 100 },
      { field: 'cameraModel', present: 80, missing: 20, total: 100 },
      { field: 'aiDescription', present: 40, missing: 60, total: 100 },
      { field: 'checksum', present: 100, missing: 0, total: 100 },
    ],
    views: [
      { view: 'timeline', photos: 70, videos: 8, total: 78, overlaps: false },
      { view: 'favorites', photos: 12, videos: 2, total: 14, overlaps: true },
      { view: 'archive', photos: 15, videos: 1, total: 16, overlaps: false },
      { view: 'trash', photos: 5, videos: 1, total: 6, overlaps: false },
    ],
    albums: { total: 0, owned: 0, shared: 0, ownedShared: 0, notShared: 0, unlisted: 0, albums: [] },
    processing: {
      available: !owner,
      attempts: owner ? 0 : 10,
      completed: owner ? 0 : 9,
      failed: owner ? 0 : 1,
      durationMs: 0,
      estimatedCostUsd: null,
      costedAttempts: 0,
      uncostedAttempts: 0,
    },
    insights: insights(hiddenItems, owner),
  };
};

const setupAnalyticsMocks = async (context: BrowserContext, hiddenItems = 0) => {
  await context.route('**/api/analytics/scopes', (route) => route.fulfill({ json: { scopes } }));
  await context.route('**/api/analytics?*', (route, request) => {
    const scope = new URL(request.url()).searchParams.get('scope') ?? 'all';
    return route.fulfill({ json: report(scope, hiddenItems) });
  });
};

/** The exact counts in a panel's data table, summed. */
const tableTotal = (page: Page, id: string) =>
  page
    .locator(`[data-table-id="${id}"] tbody tr td:last-child`)
    .evaluateAll((cells) =>
      cells.reduce((sum, cell) => sum + Number((cell.textContent ?? '0').replaceAll(',', '')), 0),
    );

test.describe.configure({ mode: 'parallel' });
test.describe('Library analytics dashboard', () => {
  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
  });

  test('opens with the hero and breakdowns that add up to the report total', async ({ context, page }) => {
    await setupAnalyticsMocks(context);
    await page.goto(`/user-settings?area=analytics&scope=account:${ownerId}`);

    await expect(page.getByRole('heading', { level: 1, name: 'Library analytics' })).toBeVisible();
    const hero = page.getByRole('region', { name: 'Library at a glance' });
    await expect(hero.getByText('Your library')).toBeVisible();
    await expect(hero.getByText('8 years')).toBeVisible();
    for (const tile of ['Added in this period', 'Volume used', 'Saved by deduplication', 'Photos · videos']) {
      await expect(hero.getByText(tile)).toBeVisible();
    }
    for (const id of ['years', 'punchcard', 'lenses', 'focal-lengths', 'orientation', 'places']) {
      expect(await tableTotal(page, id)).toBe(100);
    }
    expect((await tableTotal(page, 'photo-formats')) + (await tableTotal(page, 'video-resolutions'))).toBe(100);

    const places = page.getByRole('list', { name: 'Where they were taken' }).getByRole('listitem');
    await expect(places.first()).toContainText('Banff');
    await expect(places.last()).toContainText('No location');
  });

  test('notes hidden items and keeps people and places to the owner', async ({ context, page }) => {
    await setupAnalyticsMocks(context, 4);
    await page.goto('/user-settings?area=analytics');

    await expect(page.getByRole('note')).toContainText('4 hidden items are left out of the breakdowns below');
    expect(await tableTotal(page, 'years')).toBe(96);
    expect(await tableTotal(page, 'cameras')).toBe(96);
    // the whole-server report splits the volume by what the server measured
    const legend = page.locator('[data-panel="storage"] .an-legend');
    for (const part of ['Originals', 'Previews & thumbnails', 'Encoded video', 'Database', 'Other files']) {
      await expect(legend.getByText(part, { exact: true })).toBeVisible();
    }
    expect(await tableTotal(page, 'volume-parts')).toBe(600_000);
    await expect(page.getByText('People and places are shown only when you view your own library.')).toBeVisible();
    await expect(page.getByText('Emma')).toHaveCount(0);
  });

  test('switches the daily heatmap between captures and uploads with exact counts', async ({ context, page }) => {
    await setupAnalyticsMocks(context);
    await page.goto(`/user-settings?area=analytics&scope=account:${ownerId}`);

    await expect(page.getByRole('heading', { name: '7 captures over 7 days' })).toBeVisible();
    await page.getByLabel('Show').selectOption('uploaded');
    await expect(page.getByRole('heading', { name: '4 uploads over 7 days' })).toBeVisible();
    await page.getByText('View daily counts').click();
    expect(await tableTotal(page, 'calendar-uploaded')).toBe(4);
  });
});

test.describe('Settings area directories', () => {
  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
  });

  test('draws an area as grouped lists with coloured area tiles', async ({ page }) => {
    await page.goto('/user-settings?area=storage');

    await expect(page.getByRole('heading', { level: 1, name: 'Storage & originals' })).toBeVisible();
    const directory = page.locator('.cc-directory');
    await expect(directory.getByRole('heading', { level: 2, name: 'Identical files' })).toBeVisible();
    // No repeated area icon on the rows: only the chevron.
    await expect(directory.getByRole('button').first().locator('svg')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Library analytics' }).locator('.tile')).toBeVisible();
  });
});
