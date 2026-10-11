import { faker } from '@faker-js/faker';
import { BrowserContext, expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * Background work (FL-364; the Job manager of FL-71) in Computers & background work, against a
 * mocked server: the status sentence and the work listed under "Now", one kind of work with its
 * pause/resume through the review, Light / Balanced / Fast and the numbers behind them on the
 * settings draft, a task through "More tasks" and its review, and the old queue addresses.
 */
type Statistics = {
  active: number;
  completed: number;
  delayed: number;
  failed: number;
  paused: number;
  waiting: number;
};
type MockQueue = { name: string; isPaused: boolean; statistics: Statistics };

const statistics = (values: Partial<Statistics> = {}): Statistics => ({
  active: 0,
  completed: 0,
  delayed: 0,
  failed: 0,
  paused: 0,
  waiting: 0,
  ...values,
});

const jobManager = '/user-settings?area=processing&section=queues';

const setupQueueMocks = async (context: BrowserContext) => {
  const queues: MockQueue[] = [
    { name: 'thumbnailGeneration', isPaused: false, statistics: statistics({ active: 2, waiting: 5, completed: 40 }) },
    { name: 'faceDetection', isPaused: false, statistics: statistics({ failed: 3 }) },
    { name: 'backgroundTask', isPaused: false, statistics: statistics() },
  ];
  const requests = {
    updates: [] as Array<{ name: string; isPaused: boolean }>,
    jobs: [] as string[],
    commands: [] as Array<{ name: string; command: string }>,
    retries: [] as string[],
    ownerQueries: [] as string[],
    enrichment: [] as Array<{ path: string; body?: unknown }>,
  };

  await context.route('**/api/queues', (route) => route.fulfill({ json: queues }));
  // FL-71: a failed job names its account and worker (JobsManager.jsx 758-796).
  await context.route('**/api/queues/*/jobs*', (route, request) => {
    const url = new URL(request.url());
    const failed = url.pathname.includes('faceDetection') && url.searchParams.getAll('status').includes('failed');
    return route.fulfill({
      json: failed
        ? [
            {
              id: 'job-1',
              name: 'AssetDetectFaces',
              timestamp: Date.UTC(2026, 8, 23, 10),
              data: { id: faker.string.uuid() },
              attemptsMade: 3,
              failedReason: 'Machine learning is unreachable',
              account: { id: faker.string.uuid(), name: 'Ada Lovelace' },
              worker: { kind: 'frameleaf-cloud', name: 'Studio cloud' },
            },
          ]
        : [],
    });
  });
  // FL-71 (J-1): the accounts, and one account's counts for the Viewing scope.
  await context.route('**/api/admin/users*', (route) =>
    route.fulfill({ json: [{ id: 'a0000000-0000-4000-8000-000000000001', name: 'Grace Hopper', email: 'g@x.test' }] }),
  );
  await context.route('**/api/queues/*/statistics*', (route, request) => {
    requests.ownerQueries.push(new URL(request.url()).searchParams.get('ownerId') ?? '');
    return route.fulfill({
      json: { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, waiting: 0, truncated: false },
    });
  });
  await context.route('**/api/queues/*/jobs/retry-failed', async (route, request) => {
    const name = new URL(request.url()).pathname.split('/').at(-3)!;
    requests.retries.push(name);
    const queue = queues.find((item) => item.name === name);
    const count = queue?.statistics.failed ?? 0;
    if (queue) {
      queue.statistics.failed = 0;
    }
    return route.fulfill({ json: { count } });
  });
  await context.route('**/api/queues/*', async (route, request) => {
    const name = new URL(request.url()).pathname.split('/').at(-1)!;
    const queue = queues.find((item) => item.name === name);
    if (!queue) {
      return route.fulfill({ status: 404, json: {} });
    }
    if (request.method() === 'PUT') {
      const { isPaused } = request.postDataJSON() as { isPaused: boolean };
      queue.isPaused = isPaused;
      requests.updates.push({ name, isPaused });
    }
    return route.fulfill({ json: queue });
  });
  // Legacy queue commands (`PUT /jobs/{name}`), such as clear-failed from "Remove failed records".
  await context.route('**/api/jobs/*', async (route, request) => {
    if (request.method() !== 'PUT') {
      return route.fallback();
    }
    const name = new URL(request.url()).pathname.split('/').at(-1)!;
    const { command } = request.postDataJSON() as { command: string };
    requests.commands.push({ name, command });
    const queue = queues.find((item) => item.name === name);
    if (queue && command === 'clear-failed') {
      queue.statistics.failed = 0;
    }
    return route.fulfill({ json: queue?.statistics ?? {} });
  });
  await context.route('**/api/jobs', async (route, request) => {
    if (request.method() !== 'POST') {
      return route.fallback();
    }
    requests.jobs.push((request.postDataJSON() as { name: string }).name);
    return route.fulfill({ status: 204 });
  });
  // FL-59 (CC-42): the enrichment tasks and their reviews.
  await context.route('**/api/system-config/image-description/*', async (route, request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/requeue-estimate')) {
      return route.fulfill({ json: { totalAssets: 120, estimatedTotalSeconds: 600, withDescription: 80 } });
    }
    requests.enrichment.push({ path });
    return path.endsWith('/defer-requeue') ? route.fulfill({ status: 204 }) : route.fulfill({ json: { queued: true } });
  });
  await context.route('**/api/system-config/smart-albums/reevaluate', async (route, request) => {
    requests.enrichment.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    return route.fulfill({ json: { queued: true } });
  });
  await context.route('**/api/system-config/machine-learning/hardware*', (route) =>
    route.fulfill({ json: { preferredAcceleration: 'cuda', providers: [], openvinoDeviceIds: [] } }),
  );
  return requests;
};

test.describe.configure({ mode: 'parallel' });
test.describe('Job manager', () => {
  let requests: Awaited<ReturnType<typeof setupQueueMocks>>;

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    requests = await setupQueueMocks(context);
  });

  test('opens on the status and what is happening now, and pauses and resumes one kind of work through its review', async ({
    page,
  }) => {
    await page.goto(jobManager);

    await expect(page.getByRole('heading', { level: 1, name: 'Background work' })).toBeVisible();
    const status = page.getByRole('region', { name: 'Background work status' });
    await expect(status.getByRole('heading', { name: '3 things failed' })).toBeVisible();
    await expect(status.getByText(/Finding faces: 3 failed\./)).toBeVisible();
    const now = page.getByRole('region', { name: 'Now' });
    // "Now" lists the work in hand; every kind of work is listed again, closed, under "Show all".
    const thumbnails = now.getByRole('listitem').filter({ hasText: 'Making thumbnails' });
    await expect(thumbnails).toHaveCount(1);
    await expect(thumbnails.getByText('Running', { exact: true })).toBeVisible();
    await expect(thumbnails.getByText('7 left', { exact: true })).toBeVisible();
    // Work with nothing to do is behind "Show all kinds of work".
    await expect(now.getByText('Housekeeping')).toBeHidden();
    await now.getByText('Show all 3 kinds of work').click();
    await expect(now.getByText('Housekeeping')).toBeVisible();

    await now.getByRole('link', { name: 'Manage Making thumbnails' }).first().click();
    await page.waitForURL('**/user-settings?area=processing&section=queues&queue=thumbnail-generation');
    await expect(page.getByRole('heading', { level: 1, name: 'Making thumbnails' })).toBeVisible();

    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const pause = page.getByRole('dialog', { name: 'Pause queue' });
    await expect(pause.getByText(/Stop taking new work/)).toBeVisible();
    await pause.getByRole('button', { name: 'Pause queue' }).click();
    await expect.poll(() => requests.updates).toEqual([{ name: 'thumbnailGeneration', isPaused: true }]);

    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.getByRole('dialog', { name: 'Resume queue' }).getByRole('button', { name: 'Resume queue' }).click();
    await expect.poll(() => requests.updates.at(-1)).toEqual({ name: 'thumbnailGeneration', isPaused: false });

    const history = page.locator('details', { hasText: 'Queue action history' });
    await history.locator('summary').click();
    await expect(history.getByText('Pause queue')).toBeVisible();
    await expect(history.getByText('Resume queue')).toBeVisible();
  });

  test('removes failed records through the review, which asks for an acknowledgement', async ({ page }) => {
    await page.goto(`${jobManager}&queue=face-detection&tab=failed`);
    await expect(page.getByRole('heading', { level: 1, name: 'Finding faces' })).toBeVisible();

    await page.getByRole('button', { name: 'Stop trying these', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Stop trying these' });
    const confirm = review.getByRole('button', { name: 'Stop trying these', exact: true });
    await expect(confirm).toBeDisabled();
    await review.getByRole('checkbox').check();
    await confirm.click();

    await expect.poll(() => requests.commands).toEqual([{ name: 'faceDetection', command: 'clear-failed' }]);
  });

  test("names a failed job's account and worker, and retries failed jobs through the review", async ({ page }) => {
    await page.goto(`${jobManager}&queue=face-detection&tab=failed`);
    await expect(page.getByRole('heading', { level: 1, name: 'Finding faces' })).toBeVisible();

    const table = page.getByRole('table');
    await expect(table.getByRole('columnheader', { name: 'Account' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Worker' })).toBeVisible();
    await expect(table.getByText('Ada Lovelace')).toBeVisible();
    await expect(table.getByText('Frameleaf Cloud')).toBeVisible();

    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Try again' });
    await expect(review.getByText(/Put failed jobs back in the queue/)).toBeVisible();
    await review.getByRole('button', { name: 'Try again' }).click();

    await expect.poll(() => requests.retries).toEqual(['faceDetection']);
  });

  // The account is the command center's "Viewing" scope in the address; the page has no second
  // account select (design review finding 65).
  test("narrows a queue to one account's work from the Viewing scope", async ({ page }) => {
    await page.goto(
      `${jobManager}&queue=face-detection&tab=failed&scope=${encodeURIComponent('account:a0000000-0000-4000-8000-000000000001')}`,
    );
    await expect(page.getByRole('heading', { level: 1, name: 'Finding faces' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Account filter' })).toHaveCount(0);

    await expect.poll(() => requests.ownerQueries).toContain('a0000000-0000-4000-8000-000000000001');
    await expect(page.getByText(/Counts and job details: Grace Hopper\./)).toBeVisible();
    await expect(page.getByRole('tab', { name: /Failed\s*0/ })).toBeVisible();
  });

  test('sets how hard the server works with Light, Balanced and Fast, in the settings draft', async ({ page }) => {
    await page.goto(jobManager);

    const effort = page.getByRole('group', { name: 'How hard this server works in the background' });
    await expect(effort.getByRole('button', { name: 'Balanced' })).toHaveAttribute('aria-pressed', 'true');
    await effort.getByRole('button', { name: 'Fast' }).click();
    await expect(page.getByText(/Fast: up to 6 thumbnails, 2 videos and 4 of each AI task at a time\./)).toBeVisible();

    // The numbers behind the choice; changing one makes them the server's own ("Custom").
    await page.getByText('Set each kind of work yourself').click();
    const thumbnails = page.getByLabel('Making thumbnails at the same time');
    await expect(thumbnails).toHaveValue('6');
    await thumbnails.fill('5');
    await expect(page.getByText('Custom', { exact: true })).toBeVisible();
    await expect(page.getByText(/Your own numbers: up to 5 thumbnails/)).toBeVisible();
    await page.getByRole('button', { name: 'Back to Balanced' }).click();
    await expect(thumbnails).toHaveValue('3');
    await expect(effort.getByRole('button', { name: 'Balanced' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('runs a task from "More tasks" through its review', async ({ page }) => {
    await page.goto(jobManager);

    await page.getByRole('button', { name: 'More tasks', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a maintenance job' });
    await dialog.getByRole('searchbox', { name: 'Search maintenance jobs' }).fill('unused tags');
    await dialog.getByRole('radio', { name: /Clean up unused tags/ }).check();
    await dialog.getByRole('button', { name: 'Review job' }).click();

    await page
      .getByRole('dialog', { name: 'Clean up unused tags' })
      .getByRole('button', { name: 'Clean up unused tags' })
      .click();
    await expect.poll(() => requests.jobs).toEqual(['tag-cleanup']);
  });

  test('runs enrichment tasks through their review and keeps a description reminder', async ({ page }) => {
    await page.goto(jobManager);

    await page.getByRole('button', { name: /^Redo descriptions/ }).click();
    let dialog = page.getByRole('dialog', { name: 'Enrichment tasks' });
    await dialog.getByLabel('When').selectOption('later');
    await dialog.getByRole('button', { name: 'Review task' }).click();
    await page
      .getByRole('dialog', { name: 'Remind me to regenerate descriptions' })
      .getByRole('button', { name: 'Remind me to regenerate descriptions' })
      .click();
    await expect
      .poll(() => requests.enrichment.map(({ path }) => path))
      .toEqual(['/api/system-config/image-description/defer-requeue']);
    await expect(page.getByText('Description regeneration is waiting for your review.')).toBeVisible();

    await page.getByRole('button', { name: 'Review reminder' }).click();
    dialog = page.getByRole('dialog', { name: 'Enrichment tasks' });
    await dialog.getByLabel('Task').selectOption('smart-albums');
    await dialog.getByLabel('Categories').selectOption('food');
    await dialog.getByRole('button', { name: 'Review task' }).click();
    await page
      .getByRole('dialog', { name: 'Re-evaluate smart albums' })
      .getByRole('button', { name: 'Re-evaluate smart albums' })
      .click();
    await expect
      .poll(() => requests.enrichment.at(-1))
      .toEqual({ path: '/api/system-config/smart-albums/reevaluate', body: { kind: 'food' } });

    // A hardware preset joins the settings review instead of saving.
    await page.getByRole('button', { name: /^Redo descriptions/ }).click();
    dialog = page.getByRole('dialog', { name: 'Enrichment tasks' });
    await dialog.getByLabel('Task').selectOption('hardware');
    await dialog.getByLabel('Acceleration').selectOption('cuda');
    await dialog.getByRole('button', { name: 'Add preset to settings review' }).click();
    await expect(dialog.getByRole('status')).toHaveText(/Preset added to pending settings\./);
  });

  test('opens the old queue addresses in the Job manager', async ({ page }) => {
    await page.goto('/admin/queues');
    await page.waitForURL('**/user-settings?area=processing&section=queues');
    await expect(page.getByRole('heading', { level: 1, name: 'Background work' })).toBeVisible();

    await page.goto('/admin/queues/face-detection');
    await page.waitForURL('**/user-settings?area=processing&section=queues&queue=face-detection');
    await expect(page.getByRole('heading', { level: 1, name: 'Finding faces' })).toBeVisible();

    await page.goto('/admin/jobs-status');
    await page.waitForURL('**/user-settings?area=processing&section=queues');
  });
});
