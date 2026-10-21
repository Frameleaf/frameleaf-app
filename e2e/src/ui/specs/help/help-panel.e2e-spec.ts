import { faker } from '@faker-js/faker';
import { expect, test, type Page } from '@playwright/test';
import { createDefaultTimelineConfig, generateTimelineData, TimelineData } from 'src/ui/generators/timeline';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { setupTimelineMockApiRoutes, TimelineTestContext } from 'src/ui/mock-network/timeline-network.js';

/**
 * FL-489: the help panel (frameleaf-prototype #5). The server's `/help/*` endpoints are mocked; what
 * is asserted is that the panel shows the screen's guides, searches, reads an article in place and
 * relays a question with the screen it was asked from.
 */

const article = (id: string, title: string, headings: { title: string; text: string }[] = []) => ({
  id,
  url: `/docs/${id}/`,
  section: id.split('/', 1)[0],
  sectionTitle: 'Using Frameleaf',
  title,
  description: `About ${title.toLowerCase()}`,
  appScreens: [],
  intro: '',
  headings,
  text: '',
});

const helpIndex = {
  origin: 'https://frameleaf.app',
  builtAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T09:00:00.000Z',
  offline: false,
  screens: ['photos'],
  screenGuides: { photos: ['using/library', 'using/editing'] },
  articles: [
    article('using/editing', 'Editing'),
    article('using/library', 'Library and timeline'),
    article('using/sharing', 'Sharing', [{ title: 'Shared albums', text: 'Share an album with people.' }]),
  ],
  ask: { enabled: true, hardware: 'NVIDIA GeForce RTX 3060 · 12 GB · CUDA · Frameleaf 1.1.7' },
};

const sharingMarkdown = [
  '# Sharing',
  '',
  'Source: https://frameleaf.app/docs/using/sharing/',
  '',
  'Everyone on your server has their own private library.',
  '',
  '## Shared albums',
  '',
  'Share an album with people on your server and choose a role for each.',
].join('\n');

const openHelp = async (page: Page) => {
  await page.goto('/photos');
  await page.getByTestId('help-button').click();
  const panel = page.getByRole('dialog', { name: 'Frameleaf help' });
  await expect(panel).toBeVisible();
  return panel;
};

test.describe('help panel', () => {
  let timelineRestData: TimelineData;
  const testContext = new TimelineTestContext();
  let askBodies: unknown[] = [];

  test.beforeAll(() => {
    testContext.adminId = faker.string.uuid();
    timelineRestData = generateTimelineData({ ...createDefaultTimelineConfig(), ownerId: testContext.adminId });
  });

  test.beforeEach(async ({ context }) => {
    askBodies = [];
    await setupBaseMockApiRoutes(context, testContext.adminId);
    await setupTimelineMockApiRoutes(
      context,
      timelineRestData,
      { albumAdditions: [], assetDeletions: [], assetArchivals: [], assetFavorites: [] },
      testContext,
    );
    await context.route('**/api/help/index', (route) => route.fulfill({ json: helpIndex }));
    await context.route('**/api/help/articles/using/sharing', (route) =>
      route.fulfill({ json: { id: 'using/sharing', url: '/docs/using/sharing/', markdown: sharingMarkdown } }),
    );
    await context.route('**/api/help/ask', async (route, request) => {
      askBodies.push(request.postDataJSON());
      await route.fulfill({
        json: {
          kind: 'answer',
          blocks: [{ text: 'Open the album, choose Share and pick the people.', sourceIds: ['sharing:1'] }],
          sources: [{ id: 'sharing:1', title: 'Sharing — Shared albums', url: '/docs/using/sharing/#shared-albums' }],
          questions: [],
        },
      });
    });
  });

  test("shows the screen's guides and reads one found by search", async ({ page }) => {
    const panel = await openHelp(page);
    await expect(panel.getByRole('heading', { name: 'Help for Library' })).toBeVisible();
    await expect(panel.getByRole('option').first()).toContainText('Library and timeline');

    const field = panel.getByRole('combobox', { name: 'Search help' });
    await field.fill('shared albums');
    await expect(panel.getByRole('option', { name: /Sharing › Shared albums/ })).toBeVisible();
    await field.press('Enter');
    await expect(
      panel.getByText('Share an album with people on your server and choose a role for each.'),
    ).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Open on frameleaf.app' })).toHaveAttribute(
      'href',
      'https://frameleaf.app/docs/using/sharing/#shared-albums',
    );

    // Escape goes back to the results, then closes
    await page.keyboard.press('Escape');
    await expect(panel.getByRole('option', { name: /Sharing › Shared albums/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });

  test('asks Frameleaf from the screen and opens a cited guide', async ({ page }) => {
    const panel = await openHelp(page);
    await panel.getByRole('option', { name: 'How do I share an album with my family?' }).click();
    await expect(panel.getByText('Open the album, choose Share and pick the people.')).toBeVisible();
    expect(askBodies).toEqual([{ question: 'How do I share an album with my family?', turns: [], screen: 'photos' }]);
    await expect(panel.getByText('NVIDIA GeForce RTX 3060 · 12 GB · CUDA · Frameleaf 1.1.7')).toBeVisible();

    await panel.getByRole('button', { name: /Sharing — Shared albums/ }).click();
    await expect(
      panel.getByText('Share an album with people on your server and choose a role for each.'),
    ).toBeVisible();
  });
});
