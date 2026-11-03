import { faker } from '@faker-js/faker';
import { expect, test, type BrowserContext, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-653: Import from Eagle, from choosing a `.library` folder in the browser to the finish report.
 * The library is a small synthetic one written to a temporary folder; the server is mocked, and
 * one of the files is already in the library so the upload path reports it as a duplicate.
 */
interface FixtureItem {
  id: string;
  name: string;
  ext: string;
  folders?: string[];
  tags?: string[];
  star?: number;
  isDeleted?: boolean;
  noFile?: boolean;
}

const ITEMS: FixtureItem[] = [
  { id: 'I1', name: 'hero', ext: 'jpg', folders: ['F3', 'F4'], tags: ['hero', 'warm'], star: 5 },
  { id: 'I2', name: 'logo', ext: 'png', folders: ['F2'], tags: ['logo'] },
  { id: 'I3', name: 'loose', ext: 'webp', tags: ['warm'] },
  { id: 'I4', name: 'already', ext: 'png', folders: ['F2'] },
  { id: 'I5', name: 'Lodge Serif', ext: 'otf', folders: ['F2'] },
  { id: 'I6', name: 'old-draft', ext: 'png', isDeleted: true },
  { id: 'I7', name: 'missing', ext: 'jpg', noFile: true },
];
const bytes = (item: FixtureItem) => `bytes of ${item.id}`;

async function writeLibrary(root: string) {
  const library = join(root, 'Fixture.library');
  await mkdir(join(library, 'images'), { recursive: true });
  await writeFile(
    join(library, 'metadata.json'),
    JSON.stringify({
      folders: [
        { id: 'F1', name: 'Brand identity', iconColor: 'green', children: [{ id: 'F2', name: 'Logos', children: [] }] },
        { id: 'F3', name: 'Hero sections', iconColor: 'orange', children: [] },
        { id: 'F4', name: 'Inspiration', iconColor: 'yellow', children: [] },
      ],
      smartFolders: [{ name: 'Blue tones' }],
      tagsGroups: [],
      modificationTime: 1_790_000_000_000,
    }),
  );
  await writeFile(join(library, 'tags.json'), JSON.stringify({ historyTags: ['hero', 'warm', 'logo'] }));
  for (const item of ITEMS) {
    const folder = join(library, 'images', `${item.id}.info`);
    await mkdir(folder);
    await writeFile(
      join(folder, 'metadata.json'),
      JSON.stringify({
        id: item.id,
        name: item.name,
        ext: item.ext,
        folders: item.folders ?? [],
        tags: item.tags ?? [],
        star: item.star,
        isDeleted: item.isDeleted ?? false,
        annotation: '',
        url: '',
      }),
    );
    if (!item.noFile) {
      await writeFile(join(folder, `${item.name}.${item.ext}`), bytes(item));
    }
  }
  return library;
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', json: body });

test.describe('Import from Eagle', () => {
  test.use({ reducedMotion: 'reduce' });
  let userId: string;
  let root: string;
  let library: string;

  test.beforeAll(async () => {
    userId = faker.string.uuid();
    root = await mkdtemp(join(tmpdir(), 'frameleaf-eagle-'));
    library = await writeLibrary(root);
  });

  test.afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** The server the import talks to. `holdUploads` leaves every file upload after the first unanswered. */
  const mockServer = async (context: BrowserContext, { holdUploads = false } = {}) => {
    const albums: { albumName: string; parentId?: string; color?: string }[] = [];
    const uploads: string[] = [];
    const alreadySha = createHash('sha256').update(bytes(ITEMS[3])).digest('hex');
    const existingId = faker.string.uuid();

    await setupBaseMockApiRoutes(context, userId);
    // The browser path: the folder input, not the File System Access picker.
    await context.addInitScript(() => {
      delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    });
    await context.route('**/api/library/items/search', (route) =>
      json(route, { count: 0, countCapped: false, items: [], nextCursor: null }),
    );
    await context.route('**/api/albums/hierarchy*', (route) => json(route, { roots: [] }));
    await context.route('**/api/albums?libraryScope=design', (route) => json(route, []));
    await context.route('**/api/albums', async (route, request) => {
      if (request.method() !== 'POST') {
        return route.fallback();
      }
      const body = request.postDataJSON() as { albumName: string; parentId?: string; color?: string };
      albums.push(body);
      return json(route, { id: faker.string.uuid(), ...body, assetCount: 0, albumUsers: [], shared: false }, 201);
    });
    await context.route('**/api/albums/assets', (route) => json(route, { success: true }));
    await context.route('**/api/tags', (route, request) => {
      if (request.method() !== 'PUT') {
        return route.fallback();
      }
      const { tags } = request.postDataJSON() as { tags: string[] };
      return json(
        route,
        tags.map((value) => ({ id: faker.string.uuid(), name: value, value, createdAt: '', updatedAt: '' })),
      );
    });
    await context.route('**/api/tags/assets', (route) => json(route, { count: 1 }));
    await context.route('**/api/assets/bulk-upload-check', (route, request) => {
      const { assets } = request.postDataJSON() as { assets: { id: string; checksum: string }[] };
      return json(route, {
        results: assets.map(({ id, checksum }) =>
          checksum === alreadySha
            ? { id, action: 'reject', reason: 'duplicate', assetId: existingId, isTrashed: false }
            : { id, action: 'accept' },
        ),
      });
    });
    await context.route('**/api/assets', async (route, request) => {
      if (request.method() !== 'POST') {
        return route.fallback();
      }
      const name = /filename="([^"]+)"/.exec(request.postDataBuffer()?.toString('latin1') ?? '')?.[1] ?? '';
      uploads.push(name);
      if (holdUploads && uploads.length > 1) {
        // Never answered, as if the tab closed while sending.
        return;
      }
      return json(route, { id: faker.string.uuid(), status: 'created' }, 201);
    });
    const updates: unknown[] = [];
    await context.route('**/api/assets/*', (route, request) => {
      if (request.method() !== 'PUT') {
        return route.fallback();
      }
      updates.push(request.postDataJSON());
      return json(route, { id: request.url().split('/').pop() });
    });
    await context.route(`**/api/assets/${existingId}`, (route, request) =>
      request.method() === 'GET'
        ? json(route, {
            id: existingId,
            ownerId: userId,
            isTrashed: false,
            visibility: 'timeline',
            libraryScope: 'design',
            exifInfo: { rating: null, description: '' },
          })
        : json(route, {}),
    );

    return { albums, uploads, updates };
  };

  test('checks the library, imports it into Studio References and reconciles the report', async ({ context, page }) => {
    const { albums, uploads, updates } = await mockServer(context);

    await page.goto('/pro');
    await page.getByRole('button', { name: 'Import from Eagle…' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Import from Eagle' });
    await expect(dialog.getByText('In a folder your server can open')).toBeVisible();

    const chooser = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: 'Choose the library folder…' }).click();
    const fileChooser = await chooser;
    await fileChooser.setFiles(library);
    await expect(dialog.getByText('Fixture.library')).toBeVisible();
    await dialog.getByRole('button', { name: 'Check this library' }).click();

    const check = page.getByRole('dialog', { name: 'Check before importing' });
    await expect(check.getByText('4 items', { exact: true })).toBeVisible();
    await expect(check.getByText(/3 new · 1 already in your library/)).toBeVisible();
    await expect(check.getByText('Lodge Serif.otf')).toBeVisible();
    await expect(check.getByText('old-draft.png')).toBeVisible();
    await expect(check.getByText('missing.jpg')).toBeVisible();
    await expect(check.getByText('7 items found in Eagle = 4 that come over + 3 that can’t.')).toBeVisible();
    await check.getByRole('button', { name: 'Continue' }).click();

    const where = page.getByRole('dialog', { name: 'Where should it go?' });
    await expect(where.getByText('4 collections go into Studio References')).toBeVisible();
    await where.getByRole('button', { name: 'Import 4 items' }).click();

    const report = page.getByRole('dialog', { name: 'Import finished' });
    await expect(
      report.getByText('Every item found is accounted for, and matches the check before importing.'),
    ).toBeVisible();
    await expect(report.getByRole('button', { name: 'Show in Boards' })).toBeVisible();
    const ledger = report.getByRole('table', { name: 'How every item found in Eagle was handled' });
    await expect(ledger.getByRole('row', { name: /Added to Boards/ })).toContainText('3');
    await expect(ledger.getByRole('row', { name: /Already in your library/ })).toContainText('1');
    await expect(ledger.getByRole('row', { name: /Couldn’t come over/ })).toContainText('3');
    await expect(ledger.getByRole('row', { name: /Found in Eagle/ })).toContainText('7');
    expect(updates).toEqual([{ rating: 5 }]);

    // The file already in the library is not sent; the others are sent once each.
    expect(uploads.toSorted((a, b) => a.localeCompare(b))).toEqual(['hero.jpg', 'logo.png', 'loose.webp']);
    expect(albums.map(({ albumName }) => albumName)).toEqual([
      'Studio References',
      'Brand identity',
      'Logos',
      'Hero sections',
      'Inspiration',
    ]);
    expect(albums.find(({ albumName }) => albumName === 'Hero sections')?.color).toBe('amber');
    expect(albums.find(({ albumName }) => albumName === 'Inspiration')?.color).toBe('amber');
  });

  test('shows a closed tab as paused and asks for the library again to carry on', async ({ context, page }) => {
    await mockServer(context, { holdUploads: true });
    await page.goto('/pro');
    await page.getByRole('button', { name: 'Import from Eagle…' }).first().click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose the library folder…' }).click();
    const fileChooser = await chooser;
    await fileChooser.setFiles(library);
    await page.getByRole('button', { name: 'Check this library' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Import 4 items' }).click();
    await expect(page.getByText(/^[1-3] of 4 items$/)).toBeVisible();

    // The tab goes away mid-import; the record in this browser says where it stopped.
    await page.reload();
    const banner = page.getByRole('status').filter({ hasText: 'The Eagle import paused at' });
    await expect(banner).toContainText(/paused at [1-3] of 4 items when the tab closed/);
    await expect(banner).toContainText('Choose Fixture.library again to carry on');
    await banner.getByRole('button', { name: 'Carry on' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Import from Eagle' }).getByText('Choose Fixture.library again to carry on.', {
        exact: false,
      }),
    ).toBeVisible();
  });
});
