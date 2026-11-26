import { faker } from '@faker-js/faker';
import type { PeopleListItemDto, PersonResponseDto } from '@frameleaf/sdk';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  Changes,
  createDefaultTimelineConfig,
  generateTimelineData,
  TimelineAssetConfig,
  TimelineData,
} from 'src/ui/generators/timeline';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import {
  pageRoutePromise,
  setupTimelineMockApiRoutes,
  TimelineTestContext,
} from 'src/ui/mock-network/timeline-network.js';
import { utils } from 'src/utils.js';
import { assetViewerUtils, selectionBarUtils, thumbnailUtils, timelineUtils } from '../timeline/utils';

/**
 * FL-37: the person page (PersonDetail.jsx `PersonHeader` above the person's photos): open a photo
 * and come back, act on a selection, date-of-birth validation and the featured photo, which must
 * also change the person's People card.
 */
test.describe.configure({ mode: 'parallel' });
test.describe('person page', () => {
  let adminUserId: string;
  let timelineRestData: TimelineData;
  const assets: TimelineAssetConfig[] = [];
  const testContext = new TimelineTestContext();
  const changes: Changes = { albumAdditions: [], assetDeletions: [], assetArchivals: [], assetFavorites: [] };
  const personId = '00000000-0000-4000-8000-0000000000a1';
  let person: PersonResponseDto;
  const updates: unknown[] = [];

  test.beforeAll(() => {
    utils.initSdk();
    adminUserId = faker.string.uuid();
    testContext.adminId = adminUserId;
    timelineRestData = generateTimelineData({ ...createDefaultTimelineConfig(), ownerId: adminUserId });
    assets.length = 0;
    for (const bucket of timelineRestData.buckets.values()) {
      assets.push(...bucket);
    }
  });

  const setup = async (context: BrowserContext) => {
    person = {
      id: personId,
      name: 'Ada',
      birthDate: null,
      isHidden: false,
      isFavorite: false,
      thumbnailPath: '/thumbs/ada.jpg',
      updatedAt: '2026-01-01T00:00:00.000Z',
      notes: null,
    };
    updates.length = 0;
    await context.routeWebSocket('**/socket.io/**', () => {
      // This UI fixture has no authenticated socket session.
    });
    await setupBaseMockApiRoutes(context, adminUserId);
    await setupTimelineMockApiRoutes(context, timelineRestData, changes, testContext);
    await context.route('**/api/people/*/thumbnail*', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="teal"/></svg>',
      }),
    );
    await context.route('**/api/people**', async (route, request) => {
      const { pathname } = new URL(request.url());
      if (pathname === '/api/people/merge-suggestions' || pathname === '/api/people/split-suggestions') {
        return route.fulfill({ json: { suggestions: [] } });
      }
      if (pathname === `/api/people/${personId}/statistics`) {
        return route.fulfill({ json: { assets: 3, photos: 2, videos: 1 } });
      }
      if (pathname === `/api/people/${personId}` && request.method() === 'PUT') {
        const body = request.postDataJSON();
        updates.push(body);
        person = {
          ...person,
          ...('birthDate' in body && { birthDate: body.birthDate }),
          ...('deathDate' in body && { deathDate: body.deathDate }),
          ...('notes' in body && { notes: body.notes }),
          updatedAt: new Date().toISOString(),
        };
        return route.fulfill({ json: person });
      }
      if (pathname === `/api/people/${personId}`) {
        return route.fulfill({ json: person });
      }
      if (pathname === '/api/people') {
        const listed: PeopleListItemDto = { ...person, assetCount: 3, lastSeenAt: '2025-01-01T00:00:00.000Z' };
        return route.fulfill({ json: { people: [listed], total: 1, hidden: 0, hasNextPage: false } });
      }
      return route.fallback();
    });
    await context.route('**/api/faces?*', (route) => route.fulfill({ json: [] }));
    await context.route('**/api/assets/statistics*', (route) =>
      route.fulfill({ json: { images: 2, videos: 1, total: 3 } }),
    );
    await context.route('**/api/notifications*', (route) => route.fulfill({ json: [] }));
    await context.route('**/api/jobs/running', (route) =>
      route.fulfill({ json: { operations: [], memoryExports: [], queues: [], canManageQueues: false } }),
    );
    await context.route('**/api/media-operations*', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  };

  const openPersonPage = async (page: Page) => {
    await page.goto(`/people/${personId}`);
    await expect(page.getByRole('heading', { name: 'Ada' })).toBeVisible();
    await timelineUtils.waitForTimelineLoad(page);
  };

  test.afterEach(() => {
    changes.assetFavorites = [];
  });

  test('counts photos and videos in the hero', async ({ context, page }) => {
    await setup(context);
    await openPersonPage(page);
    await expect(page.getByText('2 photos · 1 video')).toBeVisible();
  });

  test('opens a photo from the person page and comes back to the person', async ({ context, page }) => {
    await setup(context);
    await openPersonPage(page);
    const asset = assets[0];

    await thumbnailUtils.clickAssetId(page, asset.id);
    await assetViewerUtils.waitForViewerLoad(page, asset);
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/people/${personId}/photos/${asset.id}`);

    await page.keyboard.press('Escape');
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/people/${personId}`);
    await expect(page.getByRole('heading', { name: 'Ada' })).toBeVisible();

    // the browser's Back from the viewer lands on the person page as well
    await thumbnailUtils.clickAssetId(page, asset.id);
    await assetViewerUtils.waitForViewerLoad(page, asset);
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/people/${personId}`);
    await expect(page.getByRole('region', { name: 'Ada details' })).toBeVisible();
  });

  test("acts on photos selected on the person's page", async ({ context, page }) => {
    await setup(context);
    await openPersonPage(page);
    const asset = assets[0];
    const favorite = pageRoutePromise(page, '**/api/assets', async (route, request) => {
      const body = request.postDataJSON();
      if (body.isFavorite === undefined) {
        return await route.fallback();
      }
      changes.assetFavorites.push(...body.ids);
      await route.fulfill({ status: 204 });
    });

    await thumbnailUtils.ensureSelected(page, asset.id);
    await selectionBarUtils.action(page, 'Favorite').click();

    await expect(favorite).resolves.toEqual({ isFavorite: true, ids: [asset.id] });
    await thumbnailUtils.expectThumbnailIsFavorite(page, asset.id);
  });

  test('Download asks which format and downloads in the one chosen (FL-826)', async ({ context, page }) => {
    await setup(context);
    const sized: string[] = [];
    const archived: unknown[] = [];
    await context.route('**/api/download/info*', (route, request) => {
      const { format } = request.postDataJSON();
      sized.push(format);
      const size = { original: 55_200_000, jpeg: 23_700_000, web: 2_700_000 }[format as string] ?? 0;
      return route.fulfill({
        json: { totalSize: size, archives: [{ size, assetIds: request.postDataJSON().assetIds }] },
      });
    });
    await context.route('**/api/download/archive*', (route, request) => {
      archived.push(request.postDataJSON());
      return route.fulfill({ contentType: 'application/zip', body: 'zip' });
    });
    await openPersonPage(page);
    const asset = assets[0];

    await thumbnailUtils.ensureSelected(page, asset.id);
    await selectionBarUtils.action(page, 'Download').click();

    const ask = page.getByRole('dialog', { name: 'Download' });
    await expect(ask.getByRole('radio', { name: /^Original/ })).toHaveAttribute('aria-checked', 'true');
    await expect(ask.getByRole('radio', { name: /^Web size \(2048 px\)/ })).toContainText('About 2.');
    await ask.getByRole('radio', { name: /^Web size/ }).click();
    await ask.getByRole('button', { name: 'Download', exact: true }).click();

    await expect.poll(() => archived.length).toBe(1);
    expect(archived[0]).toMatchObject({ assetIds: [asset.id], format: 'web' });
    expect(sized.at(-1)).toBe('web');
  });

  test('refuses a date of birth in the future and saves a real one', async ({ context, page }) => {
    await setup(context);
    await openPersonPage(page);

    await page
      .getByRole('toolbar', { name: 'Actions for Ada' })
      .getByRole('button', { name: 'More actions for Ada' })
      .click();
    await page.getByRole('menuitem', { name: 'Add dates' }).click();
    const dialog = page.getByRole('dialog', { name: 'Dates' });
    const field = dialog.getByLabel('Date of birth for Ada');
    const save = dialog.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeDisabled();

    await field.fill('2999-01-01');
    await expect(dialog.getByText('Choose a date that is not in the future.')).toBeVisible();
    await expect(save).toBeDisabled();
    expect(updates).toEqual([]);

    await field.fill('1990-05-17');
    await expect(dialog.getByText('Choose a date that is not in the future.')).toBeHidden();
    await expect(save).toBeEnabled();
    await save.click();

    await expect(page.getByText('Dates saved.')).toBeVisible();
    expect(updates).toEqual([{ birthDate: '1990-05-17' }]);
    await expect(page.getByRole('button', { name: /^Born / })).toBeVisible();

    // FL-864: a date of passing turns the age into a lifespan.
    await page.getByRole('button', { name: /^Born / }).click();
    await dialog.getByRole('button', { name: 'Add a date of passing' }).click();
    await dialog.getByLabel('Date of passing (optional)').fill('2021-10-09');
    await expect(dialog.getByText(/Ada’s page shows 1990 – 2021 instead of an age/)).toBeVisible();
    await save.click();

    expect(updates.at(-1)).toEqual({ deathDate: '2021-10-09' });
    await expect(page.getByRole('button', { name: '1990 – 2021' })).toBeVisible();
  });

  test('a new featured photo updates the hero and the People card', async ({ context, page }) => {
    await setup(context);
    const [photo, archived] = assets;
    // FL-37: the server names the current featured photo to the owner
    person = { ...person, featuredAssetId: photo.id } as PersonResponseDto;
    await context.route('**/api/search/metadata', (route) =>
      route.fulfill({
        json: {
          albums: { count: 0, facets: [], items: [], total: 0 },
          assets: {
            count: 2,
            facets: [],
            items: [
              { ...photo, originalFileName: 'photo.jpg', type: 'IMAGE', visibility: 'timeline', isTrashed: false },
              { ...archived, originalFileName: 'archived.jpg', type: 'IMAGE', visibility: 'archive', isTrashed: false },
            ],
            nextCursor: null,
            nextPage: null,
            total: 2,
          },
        },
      }),
    );
    await openPersonPage(page);
    const avatar = page.locator('.pd-avatar img');
    const before = await avatar.getAttribute('src');

    await page
      .getByRole('toolbar', { name: 'Actions for Ada' })
      .getByRole('button', { name: 'Featured photo' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Select featured photo' });
    // the current featured photo is marked (People.jsx:603-628)
    await expect(dialog.getByRole('radio', { name: 'photo.jpg, current featured photo' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(dialog.getByRole('radio', { name: 'archived.jpg' })).toHaveAttribute('aria-checked', 'false');
    // an archived photo of the person can be chosen too
    await dialog.getByRole('radio', { name: 'archived.jpg' }).click();

    await expect(page.getByText('Featured photo updated.')).toBeVisible();
    expect(updates).toEqual([{ featureFaceAssetId: archived.id }]);
    await expect(avatar).not.toHaveAttribute('src', before!);
    const after = await avatar.getAttribute('src');
    expect(after).toContain(`/api/people/${personId}/thumbnail`);

    await page.goto('/people');
    await expect(page.locator('.pl-card .avatar img').first()).toHaveAttribute('src', after!);
  });

  // FL-941: a private note under the header, saved through the person update, with its link shown as a link.
  test('keeps a private note on the person', async ({ context, page }) => {
    await setup(context);
    await openPersonPage(page);

    const notes = page.getByRole('region', { name: 'Notes about Ada' });
    await expect(notes.getByText('Only you can see these')).toBeVisible();
    await expect(notes.getByText('No notes yet.')).toBeVisible();
    await notes.getByRole('button', { name: 'Add a note' }).click();
    await notes
      .getByRole('textbox', { name: 'Notes about Ada' })
      .fill('Met at the hiking club. https://example.test/club');
    await expect(notes.getByText(/^49 of 2,000 characters/)).toBeVisible();
    await notes.getByRole('button', { name: 'Save' }).click();

    await expect(notes.getByRole('link', { name: 'https://example.test/club' })).toBeVisible();
    expect(updates).toEqual([{ notes: 'Met at the hiking club. https://example.test/club' }]);
    await expect(notes.getByRole('button', { name: 'Edit' })).toBeVisible();
  });
});
