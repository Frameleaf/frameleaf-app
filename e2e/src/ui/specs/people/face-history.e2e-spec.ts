import { faker } from '@faker-js/faker';
import type { PeopleListItemDto, PersonResponseDto } from '@immich/sdk';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  createDefaultTimelineConfig,
  generateTimelineData,
  TimelineData,
  toAssetResponseDto,
} from 'src/ui/generators/timeline';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { setupTimelineMockApiRoutes, TimelineTestContext } from 'src/ui/mock-network/timeline-network.js';
import { utils } from 'src/utils.js';
import { timelineUtils } from '../timeline/utils';

/**
 * FL-57: guided cleanup and correction history on the person page. Fix incorrect match splits
 * several selected faces into an existing person at once; the correction history pages 25 at a
 * time, shows "No longer available" instead of a photo whose evidence was revoked (trashed,
 * Locked or hidden since), and explains why the server refused an undo.
 */
const faceId = (index: number) => `00000000-0000-4000-8000-00000000f00${index + 1}`;

const action = (page: Page, name: string) =>
  page.getByRole('toolbar', { name: 'Actions for Ada' }).getByRole('button', { name });

test.describe.configure({ mode: 'parallel' });
test.describe('face history', () => {
  let adminUserId: string;
  let timelineRestData: TimelineData;
  const testContext = new TimelineTestContext();
  const personId = '00000000-0000-4000-8000-0000000000a1';
  const otherId = '00000000-0000-4000-8000-0000000000b2';
  const person: PersonResponseDto = {
    id: personId,
    name: 'Ada',
    birthDate: null,
    isHidden: false,
    isFavorite: false,
    thumbnailPath: '/thumbs/ada.jpg',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const other: PersonResponseDto = { ...person, id: otherId, name: 'Blair', thumbnailPath: '/thumbs/blair.jpg' };

  test.beforeAll(() => {
    utils.initSdk();
    adminUserId = faker.string.uuid();
    testContext.adminId = adminUserId;
    timelineRestData = generateTimelineData({ ...createDefaultTimelineConfig(), ownerId: adminUserId });
  });

  const photoIds = ['00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c002'];

  const correction = (index: number, overrides: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    action: 'reassign',
    createdAt: new Date(Date.UTC(2026, 8, 1) - index * 60_000).toISOString(),
    evidence: { assetId: photoIds[0], faceId: faceId(0), box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    evidenceRevoked: false,
    fromPerson: { id: otherId, name: 'Blair', exists: true },
    toPerson: { id: personId, name: 'Ada', exists: true },
    undoable: true,
    undoneAt: null,
    ...overrides,
  });

  const setup = async (context: BrowserContext) => {
    const calls = {
      moves: [] as { personId: string; faceId: string; expectedRevision: string }[],
      historyPages: [] as string[],
      undos: [] as string[],
    };
    await context.routeWebSocket('**/socket.io/**', () => {
      // This UI fixture has no authenticated socket session.
    });
    await setupBaseMockApiRoutes(context, adminUserId);
    await setupTimelineMockApiRoutes(
      context,
      timelineRestData,
      { albumAdditions: [], assetDeletions: [], assetArchivals: [], assetFavorites: [] },
      testContext,
    );
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="teal"/></svg>';
    await context.route('**/api/people/*/thumbnail*', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: svg }),
    );
    await context.route('**/api/assets/*/thumbnail*', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: svg }),
    );

    // 30 decisions: the first page holds 25, "Show more" the other 5. Decision 1 is about a photo
    // since moved to Locked (evidence revoked); decision 2 is refused because the original changed.
    const history = Array.from({ length: 30 }, (_, index) =>
      index === 1 ? correction(index, { evidence: null, evidenceRevoked: true }) : correction(index),
    );

    await context.route('**/api/people**', async (route, request) => {
      const url = new URL(request.url());
      const { pathname } = url;
      if (pathname === '/api/people/merge-suggestions') {
        return route.fulfill({ json: { suggestions: [] } });
      }
      if (pathname === `/api/people/${personId}/statistics`) {
        return route.fulfill({ json: { assets: 2, photos: 2, videos: 0 } });
      }
      if (pathname === `/api/people/${personId}/corrections`) {
        const page = Number(url.searchParams.get('page') ?? '1');
        const size = Number(url.searchParams.get('size') ?? '25');
        calls.historyPages.push(String(page));
        const corrections = history.slice((page - 1) * size, page * size);
        return route.fulfill({ json: { corrections, hasNextPage: page * size < history.length } });
      }
      const undo = pathname.match(/^\/api\/people\/corrections\/([^/]+)\/undo$/);
      if (undo) {
        calls.undos.push(undo[1]);
        if (undo[1] === history[2].id) {
          return route.fulfill({
            status: 409,
            json: { statusCode: 409, error: 'Conflict', message: 'replaced', reason: 'source-changed' },
          });
        }
        const entry = history.find(({ id }) => id === undo[1])!;
        return route.fulfill({ json: { ...entry, undoable: false, undoneAt: new Date().toISOString() } });
      }
      if (pathname === `/api/people/${personId}`) {
        return route.fulfill({ json: person });
      }
      if (pathname === '/api/people') {
        const listed = (entry: PersonResponseDto, assetCount: number): PeopleListItemDto => ({
          ...entry,
          assetCount,
          lastSeenAt: '2025-01-01T00:00:00.000Z',
        });
        return route.fulfill({
          json: { people: [listed(person, 2), listed(other, 4)], total: 2, hidden: 0, hasNextPage: false },
        });
      }
      return route.fallback();
    });

    // two photos of Ada, one face of hers in each
    await context.route('**/api/search/metadata', (route) =>
      route.fulfill({
        json: {
          albums: { count: 0, facets: [], items: [], total: 0 },
          assets: {
            count: 2,
            facets: [],
            items: photoIds.map((id, index) => ({
              ...toAssetResponseDto(timelineRestData.buckets.values().toArray()[0][0]),
              id,
              originalFileName: `photo-${index + 1}.jpg`,
              type: 'IMAGE',
              visibility: 'timeline',
              isTrashed: false,
              localDateTime: '2025-06-01T12:00:00.000Z',
            })),
            nextCursor: null,
            nextPage: null,
            total: 2,
          },
        },
      }),
    );
    await context.route('**/api/faces?*', (route, request) => {
      const assetId = new URL(request.url()).searchParams.get('id')!;
      const index = photoIds.indexOf(assetId);
      return route.fulfill({
        json:
          index === -1
            ? []
            : [
                {
                  id: faceId(index),
                  imageWidth: 1000,
                  imageHeight: 1000,
                  boundingBoxX1: 100,
                  boundingBoxY1: 100,
                  boundingBoxX2: 300,
                  boundingBoxY2: 300,
                  sourceType: 'machine-learning',
                  revision: `rev-${index}`,
                  hiddenAt: null,
                  person,
                },
              ],
      });
    });
    // moves are revision-checked corrections (FL-38 PATCH /faces/:id)
    await context.route('**/api/faces/*', async (route, request) => {
      if (request.method() !== 'PATCH') {
        return route.fallback();
      }
      const id = new URL(request.url()).pathname.split('/').pop()!;
      const body = request.postDataJSON();
      calls.moves.push({ personId: body.personId, faceId: id, expectedRevision: body.expectedRevision });
      return route.fulfill({ json: { id, person: other, revision: `${body.expectedRevision}-next` } });
    });
    await context.route('**/api/assets/statistics*', (route) =>
      route.fulfill({ json: { images: 2, videos: 0, total: 2 } }),
    );
    await context.route('**/api/notifications*', (route) => route.fulfill({ json: [] }));
    await context.route('**/api/jobs/running', (route) =>
      route.fulfill({ json: { operations: [], memoryExports: [], queues: [], canManageQueues: false } }),
    );
    await context.route('**/api/media-operations*', (route) => route.fulfill({ json: { items: [], total: 0 } }));
    return calls;
  };

  const openPersonPage = async (page: Page) => {
    await page.goto(`/people/${personId}`);
    await expect(page.getByRole('heading', { name: 'Ada' })).toBeVisible();
    await timelineUtils.waitForTimelineLoad(page);
  };

  test('splits several selected faces into an existing person at once', async ({ context, page }) => {
    const calls = await setup(context);
    await openPersonPage(page);

    await action(page, 'Fix incorrect match').click();
    const panel = page.getByRole('dialog', { name: 'Fix incorrect match' });
    await expect(panel.getByText('2 faces to review')).toBeVisible();

    await panel.getByRole('checkbox', { name: 'Select the face in photo-1.jpg' }).check();
    await panel.getByRole('checkbox', { name: 'Select the face in photo-2.jpg' }).check();
    const selection = panel.getByRole('toolbar', { name: 'Selected faces' });
    await expect(selection.getByText('2 faces selected')).toBeVisible();

    await selection.getByRole('button', { name: 'Move to…' }).click();
    const picker = panel.getByRole('group', { name: 'Move 2 faces to' });
    await picker.getByRole('button', { name: 'Blair' }).click();

    await expect(panel.getByText('2 faces moved to Blair')).toBeVisible();
    expect(calls.moves).toEqual([
      { personId: otherId, faceId: faceId(0), expectedRevision: 'rev-0' },
      { personId: otherId, faceId: faceId(1), expectedRevision: 'rev-1' },
    ]);
    await expect(panel.getByRole('checkbox', { name: 'Select the face in photo-1.jpg' })).toBeDisabled();
  });

  test('pages the correction history, hides revoked photos and explains a refused undo', async ({ context, page }) => {
    const calls = await setup(context);
    await openPersonPage(page);

    await action(page, 'Correction history').click();
    const panel = page.getByRole('dialog', { name: 'Correction history for Ada' });
    const rows = panel.locator('.pd-history-row');
    await expect(rows).toHaveCount(25);
    expect(calls.historyPages).toEqual(['1']);

    // the decision about a photo moved to Locked keeps its row but never shows the photo
    await expect(rows.nth(1).getByText('No longer available').first()).toBeVisible();
    await expect(rows.nth(1).locator('img')).toHaveCount(0);
    await expect(rows.nth(0).getByRole('button', { name: 'Open this photo' })).toBeVisible();

    await panel.getByRole('button', { name: 'Show more' }).click();
    await expect(rows).toHaveCount(30);
    expect(calls.historyPages).toEqual(['1', '2']);
    await expect(panel.getByRole('button', { name: 'Show more' })).toHaveCount(0);

    // the original of decision 2 was replaced since: the server refuses and the row says why
    await rows
      .nth(2)
      .getByRole('button', { name: /^Undo:/ })
      .click();
    await expect(rows.nth(2).getByText('The original photo was replaced since')).toBeVisible();

    await rows
      .nth(0)
      .getByRole('button', { name: /^Undo:/ })
      .click();
    await expect(rows.nth(0).getByText(/^Undone /)).toBeVisible();
    await expect(rows.nth(0).getByRole('button', { name: /^Undo:/ })).toHaveCount(0);
    expect(calls.undos).toEqual(['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000000']);
  });
});
