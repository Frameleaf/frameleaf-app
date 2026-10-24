import { faker } from '@faker-js/faker';
import { BrowserContext, expect, Page, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-416: identical files, look-alike Duplicates and Unused files, against a mocked server (the approved
 * FL-415 prototype). Library care › Duplicates says what identical files save and checks again; the
 * "Checking your Immich library" card follows the check an import started and pauses it; Unused files
 * restores and empties, and only the server owner (the first administrator) is offered it.
 */
const GB = 1_000_000_000;

const counts = (overrides: Record<string, number> = {}) => ({
  scanned: 48_210,
  upgraded: 0,
  registered: 0,
  linked: 4,
  photosMerged: 8,
  filesMovedToUnused: 214,
  bytesMovedToUnused: 3.2 * GB,
  orphansFound: 0,
  orphanDuplicates: 0,
  photosRecovered: 0,
  damaged: 0,
  problems: 0,
  ...overrides,
});
const status = (overrides: Record<string, unknown> = {}) => ({
  status: 'completed',
  stage: 'done',
  trigger: 'manual',
  startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  finishedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  totalOriginals: 48_210,
  counts: counts(),
  recovered: [],
  problems: [],
  ...overrides,
});

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', json: body });

type Server = {
  checks: number;
  restored: string[];
  emptied: number;
  paused: boolean[];
  unused: Array<{ id: string; originalFileName: string; sizeInBytes: number }>;
};

/** The mocked server. `owner` decides whether the Utilities summary counts Unused files (FL-416). */
const setupIdenticalFilesMocks = async (
  context: BrowserContext,
  { owner = true, identical = status() }: { owner?: boolean; identical?: Record<string, unknown> } = {},
) => {
  const server: Server = {
    checks: 0,
    restored: [],
    emptied: 0,
    paused: [],
    unused: Array.from({ length: 23 }, (_, index) => ({
      id: faker.string.uuid(),
      originalFileName: index === 0 ? 'VID_0311.MOV' : `IMG_${String(2040 + index)}.HEIC`,
      sizeInBytes: 0.2 * GB,
    })),
  };
  let current = identical;

  await context.route('**/api/admin/identical-files', (route) => route.fulfill(json(current)));
  await context.route('**/api/admin/identical-files/check', (route) => {
    server.checks++;
    current = status({ status: 'running', stage: 'scan', finishedAt: null, counts: counts({ scanned: 120 }) });
    return route.fulfill(json(current));
  });
  await context.route('**/api/admin/identical-files/extra-copies', (route) =>
    route.fulfill(json({ files: 0, contents: 0, bytes: 0 })),
  );
  await context.route('**/api/admin/identical-files/changes?*', (route) => route.fulfill(json([])));
  await context.route('**/api/libraries', (route) => route.fulfill(json([])));
  await context.route('**/api/analytics?*', (route) =>
    route.fulfill(json({ summary: { savedBytes: 3.2 * GB, duplicateReferences: 1140 } })),
  );
  await context.route('**/api/utilities/summary', (route) =>
    route.fulfill(
      json({
        duplicateGroups: 0,
        withoutPlace: 0,
        missingFiles: 0,
        damagedFiles: 0,
        unusedFiles: owner ? server.unused.length : null,
        unusedBytes: owner ? server.unused.reduce((sum, file) => sum + file.sizeInBytes, 0) : null,
      }),
    ),
  );
  await context.route('**/api/queues/storageTemplateMigration', (route) => {
    if (route.request().method() === 'PUT') {
      const { isPaused } = route.request().postDataJSON() as { isPaused: boolean };
      server.paused.push(isPaused);
    }
    return route.fulfill(
      json({
        name: 'storageTemplateMigration',
        isPaused: server.paused.at(-1) ?? false,
        hasUnfinishedWork: true,
        statistics: { active: 1, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0 },
      }),
    );
  });
  await context.route('**/api/admin/file-trash?*', (route) => {
    const url = new URL(route.request().url());
    const page = Number(url.searchParams.get('page') ?? 1);
    const size = Number(url.searchParams.get('size') ?? 100);
    return route.fulfill(
      json({
        items: server.unused.slice((page - 1) * size, page * size).map((file) => ({
          ...file,
          checksum: 'c'.repeat(64),
          lastOwnerId: 'taylor',
          lastOwnerName: 'Taylor',
          lastAssetId: null,
          trashedAt: new Date().toISOString(),
        })),
        total: server.unused.length,
        totalBytes: server.unused.reduce((sum, file) => sum + file.sizeInBytes, 0),
      }),
    );
  });
  await context.route('**/api/admin/file-trash/*/restore', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    server.restored.push(id);
    server.unused = server.unused.filter((file) => file.id !== id);
    return route.fulfill(json({ assetId: faker.string.uuid() }));
  });
  await context.route('**/api/admin/file-trash/empty', (route) => {
    const files = server.unused.length;
    const bytes = server.unused.reduce((sum, file) => sum + file.sizeInBytes, 0);
    server.emptied++;
    server.unused = [];
    return route.fulfill(json({ files, bytes, kept: 0 }));
  });
  return server;
};

const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test.describe('Identical files, Duplicates and Unused files (FL-416)', () => {
  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
  });

  test('Duplicates says what identical files save and checks again', async ({ context, page }) => {
    const server = await setupIdenticalFilesMocks(context);
    await page.goto('/user-settings?area=care&section=duplicates');

    const block = section(page, 'Identical files are stored once');
    await expect(block.getByText('3.2 GB', { exact: true })).toBeVisible();
    await expect(block.getByText('1,140 files are stored once')).toBeVisible();
    await expect(block.getByText('All 48,210 files, read from the drive')).toBeVisible();
    await expect(block.getByText('214 files · 3.2 GB')).toBeVisible();
    await expect(block.getByText('None. Every file was read and checked.')).toBeVisible();

    await block.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByText(/A check started\. It reads every file again/)).toBeVisible();
    await expect(block.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    await expect(block.getByText('Checking now')).toBeVisible();
    expect(server.checks).toBe(1);

    await block.getByRole('button', { name: 'Unused files' }).click();
    await expect(page).toHaveURL(/section=unused-files/);
  });

  test('Duplicates lists the files the check skipped', async ({ context, page }) => {
    await setupIdenticalFilesMocks(context, {
      identical: status({
        problems: [
          { kind: 'unreadable', assetId: null, path: 'library/morgan/IMG_3302.HEIC', detail: null },
          { kind: 'changed', assetId: null, path: 'library/taylor/VID_0098.MOV', detail: null },
        ],
      }),
    });
    await page.goto('/user-settings?area=care&section=duplicates');

    await expect(page.getByRole('heading', { name: '2 files could not be checked' })).toBeVisible();
    const block = section(page, 'Identical files are stored once');
    await expect(block.getByText('IMG_3302.HEIC')).toBeVisible();
    await expect(block.getByText('Could not be read from the drive')).toBeVisible();
    await expect(block.getByText('VID_0098.MOV')).toBeVisible();
    await expect(block.getByText('Changed while it was being read')).toBeVisible();
  });

  test('Library care follows the check after an Immich import, and pauses it', async ({ context, page }) => {
    const server = await setupIdenticalFilesMocks(context, {
      identical: status({
        status: 'running',
        stage: 'scan',
        trigger: 'immich-import',
        finishedAt: null,
        counts: counts({ scanned: 35_278, photosMerged: 100, linked: 57, bytesMovedToUnused: 2.3 * GB }),
      }),
    });
    await page.goto('/user-settings?area=care');

    const card = section(page, 'Checking your Immich library');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62');
    await expect(card.getByText('35,278 of 48,210')).toBeVisible();
    await expect(card.getByText('157', { exact: true })).toBeVisible();
    await expect(card.getByText('2.3 GB', { exact: true })).toBeVisible();
    await expect(card.getByText('Reading every file')).toBeVisible();

    await card.getByRole('button', { name: 'Pause' }).click();
    await expect(card.getByRole('button', { name: 'Resume' })).toBeVisible();
    await card.getByRole('button', { name: 'Resume' }).click();
    await expect(card.getByRole('button', { name: 'Pause' })).toBeVisible();
    expect(server.paused).toEqual([true, false]);
  });

  test('Unused files restores a file and empties with a confirm that states the size', async ({ context, page }) => {
    const server = await setupIdenticalFilesMocks(context);
    await page.goto('/user-settings?area=care');
    await page.getByRole('link', { name: /Unused files/ }).click();
    await expect(page).toHaveURL(/section=unused-files/);

    await expect(page.getByRole('heading', { name: '23 files are waiting, using 4.6 GB' })).toBeVisible();
    await expect(page.getByText('1–20 of 23')).toBeVisible();
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText('21–23 of 23')).toBeVisible();
    await page.getByRole('button', { name: 'Previous page' }).click();

    await page.getByRole('button', { name: 'Restore VID_0311.MOV' }).click();
    await expect(page.getByText('VID_0311.MOV is back in Taylor’s library.')).toBeVisible();
    expect(server.restored).toHaveLength(1);

    await page.getByRole('button', { name: 'Empty Unused files' }).click();
    const confirm = page.getByRole('dialog', { name: 'Empty Unused files and get back 4.4 GB?' });
    await expect(confirm.getByText(/22 files, 4\.4 GB in all, are deleted from the drive for good/)).toBeVisible();
    await confirm.getByRole('button', { name: 'Empty and get back 4.4 GB' }).click();
    await expect(page.getByText('22 files were deleted from the drive, giving back 4.4 GB.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Nothing is waiting' })).toBeVisible();
    expect(server.emptied).toBe(1);
  });

  test('another administrator is not offered Unused files', async ({ context, page }) => {
    await setupIdenticalFilesMocks(context, { owner: false });
    await page.goto('/user-settings?area=care');

    await expect(page.getByRole('heading', { name: 'Tools' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Unused files/ })).toHaveCount(0);

    await page.goto('/user-settings?area=care&section=duplicates');
    const block = section(page, 'Identical files are stored once');
    await expect(block.getByText(/until the server owner empties it/)).toBeVisible();
    await expect(block.getByRole('button', { name: 'Unused files' })).toHaveCount(0);
  });
});
