import { faker } from '@faker-js/faker';
import { BrowserContext, expect, Page, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-1533: Library care › Photos found on the drive against a mocked server (FL-1537). The page opens
 * from File checks, shows the found photos as pictures with a lock for another account's, a folder's
 * files are given to an account, a put-back is undone from the photo's story, and the spare copies are
 * deleted after being asked about.
 */
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', json: body });
const picture = (colour: string) => ({
  status: 200,
  contentType: 'image/svg+xml',
  body: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="${colour}"/></svg>`,
});

/** With FOUND_FILES_SHOTS set, each step is saved there as a picture, for review. */
const shot = async (page: Page, name: string) => {
  if (process.env.FOUND_FILES_SHOTS) {
    await page.screenshot({ path: `${process.env.FOUND_FILES_SHOTS}/${name}.png`, fullPage: true });
  }
};

const setupFoundFilesMocks = async (context: BrowserContext, me: string) => {
  const emma = faker.string.uuid();
  const folder = '/data/upload/5b2e1c3a';
  const file = (name: string, outcome: string, extra: Record<string, unknown> = {}) => ({
    id: faker.string.uuid({ version: 7 }),
    fileName: name,
    path: `/data/upload/${me}/3f/9a/${name}`,
    sizeInBytes: 4_200_000,
    outcome,
    reason: null,
    ownerId: me,
    assetId: faker.string.uuid(),
    viewable: true,
    sortedAt: '2026-11-12T08:40:00.000Z',
    ...extra,
  });
  const server = {
    back: [file('IMG_3310.jpg', 'back'), file('IMG_2207.HEIC', 'back')],
    added: [
      file('IMG_7731.JPG', 'added'),
      file('IMG_7732.JPG', 'added'),
      file('IMG_9002.jpg', 'added', { ownerId: emma, viewable: false }),
    ],
    spare: [file('IMG_2041 (1).jpg', 'spare'), file('cabin-export.jpg', 'spare')],
    orphans: Array.from({ length: 4 }, (_, index) =>
      file(`IMG_000${index + 1}.jpg`, 'needs', {
        reason: 'no-owner',
        ownerId: null,
        assetId: null,
        path: `${folder}/3f/9a/IMG_000${index + 1}.jpg`,
      }),
    ),
    left: 0,
    resolved: [] as unknown[],
    undone: [] as string[],
    deletes: 0,
  };
  const summary = () => ({
    back: server.back.length,
    added: server.added.length,
    spare: server.spare.length,
    spareSizeInBytes: server.spare.length * 4_200_000,
    needs: server.orphans.length,
    left: server.left,
    tidied: { previews: 18_306, previewSizeInBytes: 3_400_000_000, sidecars: 2114 },
    groups:
      server.orphans.length > 0
        ? [{ reason: 'no-owner', ownerId: null, folder, count: server.orphans.length, sizeInBytes: 16_800_000 }]
        : [],
  });
  const all = () => [...server.back, ...server.added, ...server.spare, ...server.orphans];

  await context.route('**/api/admin/found-files', (route) => route.fulfill(json(summary())));
  await context.route('**/api/admin/found-files/files?*', (route) => {
    const outcome = new URL(route.request().url()).searchParams.get('outcome');
    const items = { back: server.back, added: server.added, spare: server.spare, needs: server.orphans }[outcome ?? ''];
    return route.fulfill(json({ items: items ?? [], nextCursor: null }));
  });
  await context.route('**/api/admin/found-files/files/*/file', (route) => route.fulfill(picture('#7a8f6a')));
  await context.route('**/api/admin/found-files/files/*/undo', (route) => {
    const id = route.request().url().split('/').at(-2)!;
    const found = all().find((item) => item.id === id)!;
    server.undone.push(found.fileName);
    server.back = server.back.filter((item) => item.id !== id);
    server.added = server.added.filter((item) => item.id !== id);
    server.left++;
    return route.fulfill(json({ ...found, outcome: 'left', previousPath: null, steps: [] }));
  });
  await context.route('**/api/admin/found-files/files/*', (route) => {
    const id = route.request().url().split('/').at(-1)!;
    const found = all().find((item) => item.id === id)!;
    return route.fulfill(
      json({
        ...found,
        previousPath: found.outcome === 'back' ? '/data/library/admin/2020/08/IMG_3310.jpg' : null,
        steps: [
          { step: 'found', at: '2026-11-12T08:40:00.000Z' },
          { step: 'read', at: '2026-11-12T08:40:01.000Z', outcome: 'ok' },
          { step: found.outcome, at: '2026-11-12T08:40:02.000Z' },
        ],
      }),
    );
  });
  await context.route('**/api/admin/found-files/resolve', (route) => {
    server.resolved.push(route.request().postDataJSON());
    const added = server.orphans.length;
    server.added.push(...server.orphans.map((item) => ({ ...item, outcome: 'added', reason: null, ownerId: me })));
    server.orphans = [];
    return route.fulfill(json({ back: 0, added, spare: 0, waiting: 0, skipped: 0, nextCursor: null }));
  });
  await context.route('**/api/admin/found-files/spare/delete', (route) => {
    server.deletes++;
    const deleted = server.spare.length;
    server.spare = [];
    return route.fulfill(json({ deleted, freedBytes: deleted * 4_200_000, kept: 0, nextCursor: null }));
  });
  await context.route('**/api/admin/users*', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill(
          json([
            { id: me, name: 'Taylor', email: 'taylor@example.com' },
            { id: emma, name: 'Emma', email: 'emma@example.com' },
          ]),
        )
      : route.fallback(),
  );
  await context.route('**/api/assets/*/thumbnail*', (route) => route.fulfill(picture('#4f7fa8')));
  return { server, folder, me };
};

test.describe('Photos found on the drive (FL-1533)', () => {
  test('reviews found photos as pictures, decides for a folder, undoes a put-back and deletes spare copies', async ({
    context,
    page,
  }) => {
    const me = faker.string.uuid();
    await setupBaseMockApiRoutes(context, me);
    const { server, folder } = await setupFoundFilesMocks(context, me);
    await page.goto('/user-settings?area=care&section=found-files');

    // What needs a decision comes first: one group, one decision.
    await expect(page.getByRole('heading', { name: '5 photos are back in the library' })).toBeVisible();
    const lists = page.getByRole('group', { name: 'Show' });
    await expect(lists.getByRole('button', { name: 'Needs you · 4' })).toBeVisible();
    await expect(page.getByText('4 files in a folder no account uses')).toBeVisible();
    await expect(page.getByText('18,306 previews for photos that are gone')).toBeVisible();
    await shot(page, '1-needs');

    const add = page.getByRole('button', { name: 'Add 4 photos' });
    await expect(add).toBeDisabled();
    await page.getByLabel('Whose library these photos go to').selectOption({ label: 'Taylor’s library' });
    await add.click();
    await expect(page.getByText('4 photos are in the library now.')).toBeVisible();
    expect(server.resolved).toEqual([{ reason: 'no-owner', folder, ownerId: me }]);
    await expect(page.getByRole('heading', { name: 'Nothing needs you' })).toBeVisible();

    // Added: pictures, and a lock where the photo is another account's.
    await lists.getByRole('button', { name: 'Added · 7' }).click();
    await expect(page.getByRole('button', { name: 'What happened to IMG_7731.JPG' }).locator('img')).toBeVisible();
    const theirs = page.getByRole('button', { name: 'What happened to IMG_9002.jpg' });
    await expect(theirs.getByText('Emma’s photo')).toBeVisible();
    await expect(theirs.locator('img')).toHaveCount(0);
    await shot(page, '2-added');

    // Put back: one photo's story, and Undo.
    await lists.getByRole('button', { name: 'Put back · 2' }).click();
    await page.getByRole('button', { name: 'What happened to IMG_3310.jpg' }).click();
    const story = page.getByRole('dialog', { name: 'IMG_3310.jpg' });
    await expect(story.getByText('Read it once')).toBeVisible();
    await expect(story.getByText('/data/library/admin/2020/08/IMG_3310.jpg')).toBeVisible();
    await shot(page, '3-story');
    await story.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText(/listed as missing again/)).toBeVisible();
    expect(server.undone).toEqual(['IMG_3310.jpg']);
    await expect(lists.getByRole('button', { name: 'Put back · 1' })).toBeVisible();

    // Spare copies are deleted only after being asked about.
    await lists.getByRole('button', { name: 'Spare copies · 2' }).click();
    await page.getByRole('button', { name: 'Delete 2 spare copies…' }).click();
    const ask = page.getByRole('dialog', { name: 'Delete 2 spare copies?' });
    await expect(ask).toContainText('can’t be undone');
    expect(server.deletes).toBe(0);
    await shot(page, '4-delete-spare');
    await ask.getByRole('button', { name: 'Delete 2 copies' }).click();
    await expect(page.getByText(/2 spare copies deleted, freeing/)).toBeVisible();
    await expect(page.getByText('Nothing here yet.')).toBeVisible();
  });

  test('File checks shows what became of the files and opens the page', async ({ context, page }) => {
    const me = faker.string.uuid();
    await setupBaseMockApiRoutes(context, me);
    await setupFoundFilesMocks(context, me);
    await page.goto('/user-settings?area=care&section=integrity-checks');

    await expect(page.getByRole('heading', { name: '11 files weren’t in a library' })).toBeVisible();
    await expect(page.getByText('5 are photos again')).toBeVisible();
    await expect(page.getByText('2 are spare copies')).toBeVisible();
    await shot(page, '5-file-checks');
    await page.getByRole('button', { name: 'See the photos' }).click();
    await expect(page).toHaveURL(/section=found-files/);
    await expect(page.getByRole('region', { name: 'Photos found on the drive' })).toBeVisible();
  });
});
