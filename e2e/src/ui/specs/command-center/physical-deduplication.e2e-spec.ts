import { faker } from '@faker-js/faker';
import { BrowserContext, expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * Storage → Physical deduplication (FL-73), the design template's `PhysicalDedupManager.jsx`,
 * against a mocked server: applying can only start from the plan on screen once the server has
 * reviewed it, a stale plan is refused and never applied, preparing is blocked by a configuration
 * error, and a finished apply is verified with what can and cannot be undone said plainly.
 */
const page_ = '/user-settings?area=storage&section=deduplication';
const taylor = 'a0000000-0000-4000-8000-000000000001';
const jamie = 'a0000000-0000-4000-8000-000000000002';
const fingerprint = 'ab'.repeat(32);

const plan = (overrides: Record<string, unknown> = {}) => ({
  mode: 'dry-run',
  ranAt: '2026-09-24T10:00:00.000Z',
  masterUserId: taylor,
  masterUserName: 'Taylor',
  scopeUserId: null,
  scopeUserName: null,
  eligibleAssets: 1,
  linkedAssets: 0,
  skippedExternal: 0,
  skippedMissingMaster: 0,
  reclaimableBytes: 2048,
  deletedBytes: 0,
  logicalBytes: 4096,
  sharedOriginalBytes: 2048,
  retained: [
    {
      assetId: 'b0000000-0000-4000-8000-000000000001',
      ownerId: taylor,
      ownerName: 'Taylor',
      canView: false,
      originalFileName: 'Moraine Lake.jpg',
      originalPath: '/upload/taylor/lake.jpg',
      type: 'IMAGE',
      sizeInBytes: 2048,
      checksum: 'a'.repeat(40),
      referencesBefore: 1,
      referencesAfter: 2,
      hiddenCopies: 0,
      fileAvailable: true,
      width: 6000,
      height: 4000,
      duration: null,
    },
  ],
  copies: [
    {
      assetId: 'b0000000-0000-4000-8000-000000000002',
      ownerId: jamie,
      ownerName: 'Jamie',
      canView: false,
      originalFileName: 'Moraine Lake.jpg',
      originalPath: '/upload/jamie/lake.jpg',
      type: 'IMAGE',
      sizeInBytes: 2048,
      checksum: 'a'.repeat(40),
      retainedAssetId: 'b0000000-0000-4000-8000-000000000001',
      checksumMatch: true,
      decision: 'share',
      reason: null,
      width: 6000,
      height: 4000,
      duration: null,
    },
  ],
  copiesTruncated: false,
  planId: 'PD-ABABABAB',
  fingerprint,
  applicableCopies: 1,
  hiddenCopies: 0,
  ...overrides,
});

type Preview = Record<string, unknown>;

const setupDedupMocks = async (context: BrowserContext, preview: Preview, options: { stale?: boolean } = {}) => {
  const requests = { reviews: [] as unknown[], applies: [] as unknown[], verifies: [] as string[] };

  await context.route('**/api/admin/users*', (route) =>
    route.fulfill({
      json: [
        { id: taylor, name: 'Taylor', email: 'taylor@x.test' },
        { id: jamie, name: 'Jamie', email: 'jamie@x.test' },
      ],
    }),
  );
  await context.route('**/api/admin/physical-deduplication/preview', (route, request) =>
    request.method() === 'GET' ? route.fulfill({ json: preview }) : route.fulfill({ status: 204 }),
  );
  await context.route('**/api/admin/physical-deduplication/plan/review', (route, request) => {
    requests.reviews.push(request.postDataJSON());
    if (options.stale) {
      return route.fulfill({
        status: 409,
        json: { message: 'A newer preview replaced this plan. Review the latest plan.', statusCode: 409 },
      });
    }
    return route.fulfill({
      json: {
        planId: 'PD-ABABABAB',
        fingerprint,
        reviewToken: 'cd'.repeat(32),
        confirmation: 'APPLY PD-ABABABAB',
        excludedRetainedAssetIds: [],
        copies: 1,
        retainedOriginals: 1,
        estimatedBytes: 2048,
        hiddenCopies: 0,
        reviewedAt: '2026-09-24T10:01:00.000Z',
      },
    });
  });
  await context.route('**/api/admin/physical-deduplication/plan/apply', (route, request) => {
    requests.applies.push(request.postDataJSON());
    return route.fulfill({ status: 201, json: { id: 'c0000000-0000-4000-8000-000000000001' } });
  });
  await context.route('**/api/admin/physical-deduplication/applies/*/verify', (route, request) => {
    requests.verifies.push(new URL(request.url()).pathname.split('/').at(-2)!);
    return route.fulfill({
      json: {
        operationId: 'c0000000-0000-4000-8000-000000000001',
        planId: 'PD-ABABABAB',
        verifiedAt: '2026-09-24T10:10:00.000Z',
        copies: 1,
        verified: 1,
        retainedOriginals: 1,
        retainedIntact: 1,
        retainedMissing: 0,
        retainedChanged: 0,
        notLinked: 0,
        restored: 0,
        restorable: 0,
        removed: 1,
        hiddenCopies: 0,
        items: [
          {
            assetId: 'b0000000-0000-4000-8000-000000000002',
            ownerName: 'Jamie',
            originalFileName: 'Moraine Lake.jpg',
            type: 'IMAGE',
            canView: false,
            retainedFile: 'intact',
            linked: true,
            copyFile: 'removed',
            restored: false,
            restorable: false,
          },
        ],
      },
    });
  });
  return requests;
};

const basePreview = (overrides: Preview = {}): Preview => ({
  plan: plan(),
  savedMasterUserId: taylor,
  enabled: true,
  running: false,
  applying: false,
  applies: [],
  ...overrides,
});

test.describe.configure({ mode: 'parallel' });
test.describe('Physical deduplication', () => {
  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
  });

  test('never offers Apply for a plan the server has not reviewed', async ({ context, page }) => {
    const requests = await setupDedupMocks(context, basePreview());
    await page.goto(page_);

    await expect(page.getByRole('heading', { name: 'PD-ABABABAB' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply reviewed plan' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Mark plan reviewed' }).click();
    await page.getByRole('button', { name: 'Apply reviewed plan' }).click();
    const dialog = page.getByRole('dialog', { name: 'Apply this reviewed plan?' });
    const confirm = dialog.getByRole('button', { name: 'Apply this plan' });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('textbox').fill('APPLY PD-00000000');
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('textbox').fill('APPLY PD-ABABABAB');
    await confirm.click();

    await expect
      .poll(() => requests.applies)
      .toEqual([
        expect.objectContaining({ fingerprint, reviewToken: 'cd'.repeat(32), confirmation: 'APPLY PD-ABABABAB' }),
      ]);
  });

  test('asks for a new review when a group decision changes after the review', async ({ context, page }) => {
    const requests = await setupDedupMocks(context, basePreview());
    await page.goto(page_);

    await page.getByRole('button', { name: 'Mark plan reviewed' }).click();
    await expect(page.getByRole('button', { name: 'Apply reviewed plan' })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Share this original in the plan' }).uncheck();

    await expect(page.getByRole('button', { name: 'Apply reviewed plan' })).toHaveCount(0);
    expect(requests.applies).toEqual([]);
  });

  test('refuses a stale plan and applies nothing', async ({ context, page }) => {
    const requests = await setupDedupMocks(context, basePreview(), { stale: true });
    await page.goto(page_);

    await page.getByRole('button', { name: 'Mark plan reviewed' }).click();

    await expect(page.getByRole('alert')).toContainText('This plan no longer matches the library');
    await expect(page.getByRole('button', { name: 'Apply reviewed plan' })).toHaveCount(0);
    expect(requests.reviews).toHaveLength(1);
    expect(requests.applies).toEqual([]);
  });

  test('blocks preparing a plan until file reuse is enabled', async ({ context, page }) => {
    await setupDedupMocks(context, basePreview({ plan: null, enabled: false }));
    await page.goto(page_);

    await expect(page.getByText('Enable file reuse before preparing a plan.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Prepare preview plan' })).toBeDisabled();
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.waitForURL(/openSetting=dedup-owner/);
  });

  test('verifies a finished apply and says a removed copy cannot be undone', async ({ context, page }) => {
    const requests = await setupDedupMocks(
      context,
      basePreview({
        plan: plan({ mode: 'apply', deletedBytes: 2048, linkedAssets: 1 }),
        applies: [
          {
            operationId: 'c0000000-0000-4000-8000-000000000001',
            planId: 'PD-ABABABAB',
            fingerprint,
            status: 'completed',
            requestedById: taylor,
            requestedByName: 'Taylor',
            mine: true,
            retrying: false,
            pauseRequested: false,
            total: 1,
            processed: 1,
            progress: 100,
            applied: 1,
            alreadyApplied: 0,
            skipped: 0,
            failed: 0,
            estimatedBytes: 2048,
            reclaimedBytes: 2048,
            error: null,
            createdAt: '2026-09-24T10:05:00.000Z',
            finishedAt: '2026-09-24T10:06:00.000Z',
          },
        ],
      }),
    );
    await page.goto(page_);

    await page.getByRole('button', { name: 'Verify', exact: true }).first().click();

    const report = page.getByRole('region', { name: 'Verification of PD-ABABABAB' });
    await expect(report.getByText(/1 of 1 copies use a retained original/)).toBeVisible();
    await expect(report.getByText(/cannot come back/)).toBeVisible();
    await expect(report.getByRole('button', { name: 'Restore own file' })).toHaveCount(0);
    expect(requests.verifies).toEqual(['c0000000-0000-4000-8000-000000000001']);
  });
});
