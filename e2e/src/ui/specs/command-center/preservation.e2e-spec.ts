import { faker } from '@faker-js/faker';
import { BrowserContext, expect, Page, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * Preservation packages (FL-74, `IMP-006`) against a mocked server: the Originals & preservation
 * section of Import & protection (settings-catalog.mjs `preservation`, CommandCenter.jsx
 * `preservation` workflow) from export to reconciliation.
 *
 * - Export a typed search, then verify the written package and read what is missing or changed.
 * - Check a package for restoration, choose the package's value for one difference, restore, lose
 *   the job part-way (an interrupted import), and try the failed items again (a repeated import):
 *   the choice survives and is not sent again, and the finished restoration still says a complete
 *   download is not a complete restore, with generated captions kept only as provenance.
 * - Reopen a restoration whose package has gone (an unavailable source): it says so and offers no
 *   restore.
 *
 * The mock keeps its state per test in `state`, so each request answers from what the page did.
 */
const section = '/user-settings?area=backup&section=preservation';
const now = '2026-09-25T10:00:00.000Z';

const support = [
  { category: 'originals', level: 'restored' },
  { category: 'descriptions', level: 'restored' },
  { category: 'albums', level: 'restored' },
  { category: 'editRecipes', level: 'restored' },
  { category: 'momentNotes', level: 'restored-when-empty' },
  { category: 'documentCorrections', level: 'restored-when-empty' },
  { category: 'generatedDescriptions', level: 'provenance-only' },
  { category: 'generatedMoments', level: 'provenance-only' },
  { category: 'sharing', level: 'not-included' },
];

const operationOf = (kind: string, status: string, overrides: Record<string, unknown> = {}) => ({
  id: faker.string.uuid(),
  kind,
  status,
  label: 'Harbour receipts',
  destination: 'local',
  destinationDetail: null,
  assetId: null,
  resultAssetId: null,
  retryOfId: null,
  projectId: null,
  revisionId: null,
  settings: {},
  estimate: null,
  bulk: null,
  progress: status === 'completed' ? 100 : 0,
  processedUnits: '0',
  totalUnits: null,
  attempt: 1,
  maxAttempts: 3,
  autoRetries: 0,
  retryAt: null,
  error: status === 'failed' ? 'The server restarted' : null,
  errorCode: null,
  pausable: true,
  withheld: false,
  cancelRequestedAt: null,
  cancelAcknowledgedAt: null,
  pauseRequestedAt: null,
  startedAt: now,
  finishedAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const counts = (values: Record<string, number> = {}) => ({
  total: 2,
  pending: 0,
  copied: 0,
  failed: 0,
  skipped: 0,
  listed: 0,
  locked: 0,
  ...values,
});

const restoreCounts = (values: Record<string, number> = {}) => ({
  total: 2,
  pending: 0,
  ready: 0,
  failed: 0,
  restored: 0,
  matched: 0,
  skipped: 0,
  new: 1,
  existing: 1,
  trashed: 0,
  locked: 0,
  conflicts: 1,
  findings: 1,
  ...values,
});

const restoreOf = (overrides: Record<string, unknown>) => ({
  id: 'restore-1',
  packageId: 'package-1',
  name: 'Harbour receipts',
  status: 'reviewing',
  reasonKey: null,
  restoreEditRecipes: true,
  conflictDefault: 'keep',
  albums: 1,
  people: 0,
  counts: restoreCounts(),
  support,
  operation: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

type State = {
  preview: unknown[];
  created: Array<Record<string, unknown>>;
  package: Record<string, unknown> | null;
  restores: Array<Record<string, unknown>>;
  decisions: unknown[];
  applies: string[];
};

const setupPreservationMocks = async (context: BrowserContext) => {
  const state: State = {
    preview: [],
    created: [],
    package: null,
    restores: [],
    decisions: [],
    applies: [],
  };
  const conflictItem = (decision: string | null, applied = false) => ({
    id: 'item-conflict',
    sourceAssetId: faker.string.uuid(),
    name: 'receipt.jpg',
    state: applied ? 'matched' : 'ready',
    match: 'existing',
    assetId: faker.string.uuid(),
    locked: false,
    applied,
    reasonKey: null,
    error: null,
    findings: [],
    conflicts: [{ field: 'description', current: 'Lunch', archived: 'Harbour lunch receipt', decision }],
  });
  const failedItem = {
    id: 'item-failed',
    sourceAssetId: faker.string.uuid(),
    name: 'harbour.jpg',
    state: 'failed',
    match: 'new',
    assetId: null,
    locked: false,
    applied: false,
    reasonKey: 'package_entry_missing',
    error: null,
    findings: ['generated_moments_provenance'],
    conflicts: [],
  };

  await context.route('**/api/preservation/**', async (route, request) => {
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/api\/preservation/, '');
    const method = request.method();

    if (path === '/preview' && method === 'POST') {
      state.preview.push(request.postDataJSON());
      return route.fulfill({
        json: {
          items: 2,
          bytes: '4096',
          lockedItems: 0,
          lockedBytes: '0',
          includedItems: 2,
          includedBytes: '4096',
          maxItems: 100_000,
          withinLimit: true,
          lockedAllowed: false,
          freeBytes: '1073741824',
          support,
        },
      });
    }
    if (path === '/packages' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.created.push(body);
      // The export ran and was published: one original went missing afterwards, one was changed.
      state.package = {
        id: 'package-1',
        name: body.name,
        origin: 'export',
        status: 'ready',
        format: 'directory',
        includeLocked: false,
        includeMetadata: true,
        lockedContent: false,
        downloadable: true,
        restorable: true,
        scopeDescription: 'Search',
        sizeBytes: '4096',
        expiresAt: null,
        counts: counts({ copied: 2 }),
        manifest: {
          packageId: faker.string.uuid(),
          createdAt: now,
          producerVersion: '3.0.0',
          complete: true,
          exported: 2,
          failed: 0,
          skipped: 0,
          locked: 0,
          includeLocked: false,
          includeMetadata: true,
          scopeDescription: 'Search',
        },
        verification: null,
        support,
        operation: operationOf('preservation_export', 'completed', { finishedAt: now }),
        createdAt: now,
        updatedAt: now,
      };
      return route.fulfill({ status: 201, json: state.package });
    }
    if (path === '/packages' && method === 'GET') {
      return route.fulfill({ json: state.package ? [state.package] : [] });
    }
    if (path === '/packages/package-1/verify' && method === 'POST') {
      const operation = operationOf('preservation_verify', 'completed', { finishedAt: now });
      state.package = {
        ...state.package,
        status: 'ready',
        operation,
        verification: {
          status: 'problems',
          checked: 2,
          ok: 0,
          missing: 1,
          changed: 1,
          unexpected: 0,
          documentsChanged: [],
          reasonKey: null,
          finishedAt: now,
        },
      };
      return route.fulfill({ status: 201, json: operation });
    }
    if (path === '/restores' && method === 'GET') {
      return route.fulfill({ json: state.restores });
    }
    if (path === '/restores' && method === 'POST') {
      const restore = restoreOf({ operation: operationOf('preservation_review', 'rendering') });
      state.restores = [restore];
      return route.fulfill({ status: 201, json: restore });
    }
    const restoreMatch = /^\/restores\/([^/]+)(\/.*)?$/.exec(path);
    if (restoreMatch) {
      const [, id, rest = ''] = restoreMatch;
      const index = state.restores.findIndex((item) => item.id === id);
      if (index === -1) {
        return route.fulfill({ status: 404, json: { message: 'Restoration not found' } });
      }
      const current = state.restores[index];
      const decided = state.decisions.length > 0 ? 'replace' : null;
      if (rest === '' && method === 'GET') {
        // The review finishes on the first poll; a restore job is lost on its first poll.
        if (current.status === 'reviewing') {
          state.restores[index] = {
            ...current,
            status: 'ready',
            operation: operationOf('preservation_review', 'completed'),
          };
        } else if (current.status === 'restoring' && state.applies.length === 1) {
          state.restores[index] = {
            ...current,
            operation: operationOf('preservation_restore', 'failed', { finishedAt: now }),
            counts: restoreCounts({ matched: 1, failed: 1 }),
          };
        } else if (current.status === 'restoring' && state.applies.length === 2) {
          state.restores[index] = {
            ...current,
            status: 'completed',
            operation: operationOf('preservation_restore', 'completed', { finishedAt: now }),
            counts: restoreCounts({ matched: 1, restored: 1, failed: 0 }),
          };
        }
        return route.fulfill({ json: state.restores[index] });
      }
      if (rest === '/items' && method === 'GET') {
        const filter = url.searchParams.get('filter');
        const applied = current.status === 'completed' || state.applies.length > 0;
        const byFilter: Record<string, unknown[]> = {
          conflicts: [conflictItem(decided, applied)],
          failed: [failedItem],
          findings: [failedItem],
        };
        const items = byFilter[filter ?? ''] ?? [conflictItem(decided, applied), failedItem];
        return route.fulfill({ json: { items, total: items.length } });
      }
      if (rest === '/decisions' && method === 'PUT') {
        state.decisions.push(request.postDataJSON());
        return route.fulfill({ json: current });
      }
      if (rest === '/apply' && method === 'POST') {
        if (current.status === 'unreadable') {
          return route.fulfill({
            status: 400,
            json: { message: 'The package this restoration reads from has been removed' },
          });
        }
        state.applies.push(id);
        const operation = operationOf('preservation_restore', 'rendering');
        state.restores[index] = { ...current, status: 'restoring', operation };
        return route.fulfill({ status: 201, json: operation });
      }
    }
    return route.fulfill({ status: 404, json: { message: `Unmocked ${method} ${path}` } });
  });

  return {
    state,
    addUnavailableRestore: () => {
      state.restores.push(
        restoreOf({
          id: 'restore-gone',
          packageId: null,
          name: 'Old laptop package',
          status: 'unreadable',
          reasonKey: 'package_unavailable',
          operation: operationOf('preservation_review', 'completed'),
        }),
      );
    },
  };
};

const exportSearch = async (page: Page) => {
  await page.getByRole('button', { name: 'Preview preservation manifest' }).click();
  const dialog = page.getByRole('dialog', { name: 'Preservation export' });
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  await dialog.getByRole('searchbox', { name: /^Items matching/ }).fill('Harbour Street');
  await expect(dialog.getByText('Text: “Harbour Street”')).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog.getByText('Checksums', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog.getByText('Kept as provenance only')).toBeVisible();
  await dialog.getByRole('button', { name: 'Start export' }).click();
  await expect(dialog).toBeHidden();
};

test.describe.configure({ mode: 'parallel' });
test.describe('Preservation packages', () => {
  let mocks: Awaited<ReturnType<typeof setupPreservationMocks>>;

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    mocks = await setupPreservationMocks(context);
  });

  test('exports a typed search, then verifies the package and reports what is missing or changed', async ({ page }) => {
    await page.goto(section);
    // The closed export dialog keeps the same toggle in the DOM, so read the section's own switch.
    const checksums = page.getByRole('switch', { name: 'Include checksums and a manifest' });
    await expect(checksums).toBeChecked();
    await expect(checksums).toBeDisabled();
    await expect(page.getByText('Always protected').filter({ visible: true })).toBeVisible();

    await exportSearch(page);

    const filter = {
      or: [
        { originalFileName: { like: 'Harbour Street' } },
        { description: { like: 'Harbour Street' } },
        { ocr: { matches: 'Harbour Street' } },
        { originalPath: { like: 'Harbour Street' } },
      ],
    };
    expect(mocks.state.preview).toEqual([{ scope: { filter }, includeLocked: false }]);
    expect(mocks.state.created).toEqual([
      expect.objectContaining({ scope: { filter }, includeMetadata: true, includeLocked: false }),
    ]);

    const row = page.locator('.packages > li', { hasText: 'Search' });
    await expect(row.getByText('Not verified')).toBeVisible();
    await expect(row.getByRole('link', { name: 'Download package' })).toHaveAttribute(
      'href',
      /\/api\/preservation\/packages\/package-1\/download$/,
    );

    await row.getByRole('button', { name: 'Verify files' }).click();
    await expect(row.getByText('Problems found')).toBeVisible();
    await expect(row.getByText(/0 match · 1 missing · 1 changed · 0 unexpected/)).toBeVisible();
  });

  test('reviews a restoration, keeps the owner’s choice through an interrupted and repeated restore', async ({
    page,
  }) => {
    await page.goto(section);
    await exportSearch(page);

    await page.getByRole('button', { name: 'Restore…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore from a package' });
    await dialog.getByRole('button', { name: 'Check package' }).click();

    // The review job finishes on the next poll and lands on the differences.
    await expect(dialog.getByText('receipt.jpg')).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText('Harbour lunch receipt')).toBeVisible();
    await expect(dialog.getByText('Kept as provenance only')).toBeVisible();
    await expect(dialog.getByText(/Generated moment captions/)).toBeVisible();

    const description = dialog.getByRole('group', { name: 'Description' });
    await description.getByRole('button', { name: 'Use package' }).click();
    await expect
      .poll(() => mocks.state.decisions)
      .toEqual([{ items: [{ id: 'item-conflict', decisions: { description: 'replace' } }] }]);

    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    expect(mocks.state.applies).toEqual(['restore-1']);

    // The first restore job is lost part-way: one item failed, and it can be tried again.
    const again = dialog.getByRole('button', { name: 'Try failed items again' });
    await expect(again).toBeVisible({ timeout: 15_000 });
    await again.click();
    await expect.poll(() => mocks.state.applies).toEqual(['restore-1', 'restore-1']);

    // The retry resent nothing the owner chose; the choice is still the one they made.
    expect(mocks.state.decisions).toHaveLength(1);
    await expect(dialog.getByText('A complete download is not a complete restore', { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await dialog.getByRole('button', { name: 'Differences' }).click();
    await expect(
      dialog.getByRole('group', { name: 'Description' }).getByRole('button', { name: 'Use package' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('says a restoration’s package is no longer available and offers no restore', async ({ page }) => {
    mocks.addUnavailableRestore();
    await page.goto(section);

    const restorations = page.locator('section', { hasText: 'Restorations in progress' });
    await restorations.locator('li', { hasText: 'Old laptop package' }).getByRole('button', { name: 'Open' }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore from a package' });
    await expect(dialog.getByRole('alert')).toHaveText('The package is no longer available.');
    await expect(dialog.getByRole('button', { name: 'Restore', exact: true })).toHaveCount(0);
    expect(mocks.state.applies).toEqual([]);
  });
});
