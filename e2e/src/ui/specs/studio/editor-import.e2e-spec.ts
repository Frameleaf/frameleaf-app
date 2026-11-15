import { faker } from '@faker-js/faker';
import { expect, test, type BrowserContext, type Route } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-1544: Import a project from another editor, from choosing a Final Cut Pro XML file on the Studio
 * projects page to the finished report. The server is mocked: the check finds one file, offers one as
 * a likely match and has one not in the library, and the build makes one project.
 */
const fixture = fileURLToPath(
  new URL('../../../../../server/test/fixtures/studio-interchange/lake-day.fcpxml', import.meta.url),
);

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', json: body });

const check = {
  fileName: 'lake-day.fcpxml',
  source: 'finalcut',
  sourceVersion: '1.10',
  notices: [{ code: 'clips-disabled', subject: '1', what: 'A clip switched off in Final Cut Pro', became: 'Left out' }],
  timelines: [
    {
      index: 0,
      name: 'Lake day',
      durationSeconds: 18,
      clips: 4,
      transitions: 1,
      titles: 1,
      sound: 1,
      markers: 1,
      notes: [
        {
          code: 'effect-dropped',
          clip: 'Kayak.mp4',
          what: 'Film Glow, from a plug-in',
          became: 'Left out',
          atSeconds: 6,
        },
      ],
    },
  ],
  media: [
    {
      key: 'lake',
      name: 'Lake morning.mov',
      kind: 'video',
      clips: 1,
      match: 'found',
      confidence: 1,
      assetId: faker.string.uuid(),
      assetName: 'Lake morning.mov',
      carried: false,
    },
    {
      key: 'kayak',
      name: 'Kayak.mp4',
      kind: 'video',
      clips: 1,
      match: 'likely',
      confidence: 0.7,
      assetId: faker.string.uuid(),
      assetName: 'Kayak.mov',
      carried: false,
    },
    {
      key: 'ridge',
      name: 'Ridge.jpg',
      kind: 'image',
      clips: 1,
      match: 'missing',
      confidence: 0,
      assetId: null,
      assetName: null,
      carried: false,
    },
  ],
};

const mockServer = async (context: BrowserContext) => {
  const userId = faker.string.uuid();
  const checkId = '0195e2a0-0000-7000-8000-000000000001';
  const buildId = '0195e2a0-0000-7000-8000-000000000002';
  const projectId = '0195e2a0-0000-7000-8000-000000000003';
  const started: unknown[] = [];
  await setupBaseMockApiRoutes(context, userId);
  await context.route('**/api/studio/projects?*', (route) => json(route, { items: [], total: 0 }));
  await context.route('**/api/studio/editor-imports/uploads', (route) =>
    json(route, { id: faker.string.uuid(), fileName: 'lake-day.fcpxml', sizeBytes: 4096 }, 201),
  );
  await context.route('**/api/studio/editor-imports', (route) => json(route, { id: checkId, status: 'queued' }, 201));
  await context.route(`**/api/studio/editor-imports/${checkId}`, (route) =>
    json(route, {
      id: checkId,
      status: 'completed',
      stage: 'check',
      step: 'done',
      progress: 100,
      error: null,
      check,
      build: null,
    }),
  );
  await context.route(`**/api/studio/editor-imports/${checkId}/import`, (route, request) => {
    started.push(request.postDataJSON());
    return json(route, { jobs: [{ id: buildId, timeline: 0, status: 'queued' }] }, 201);
  });
  await context.route(`**/api/studio/editor-imports/${buildId}`, (route) =>
    json(route, {
      id: buildId,
      status: 'completed',
      stage: 'build',
      step: 'done',
      progress: 100,
      error: null,
      check: null,
      build: {
        projectId,
        name: 'Lake day',
        source: 'finalcut',
        fileName: 'lake-day.fcpxml',
        timeline: 0,
        notes: check.timelines[0].notes,
        notices: [],
        media: { found: 1, matched: 1, added: 0, placeholders: 1, total: 3 },
      },
    }),
  );
  return { started };
};

test.describe('Import from another editor', () => {
  test.use({ reducedMotion: 'reduce' });

  test('checks a Final Cut Pro project, finds its media and reports what came over', async ({ context, page }) => {
    const { started } = await mockServer(context);
    await page.goto('/studio/projects');
    await page.getByRole('button', { name: 'Import' }).first().click();
    const pick = page.getByRole('dialog', { name: 'Import a project' });
    await expect(pick.getByText('Beta')).toBeVisible();

    const chooser = page.waitForEvent('filechooser');
    await pick.getByRole('button', { name: 'Choose a project file…' }).click();
    const fileChooser = await chooser;
    await fileChooser.setFiles(fixture);
    await expect(pick.getByText('lake-day.fcpxml')).toBeVisible();
    await pick.getByRole('button', { name: 'Check this project' }).click();

    const checked = page.getByRole('dialog', { name: 'Check what comes over' });
    await expect(checked.getByText('lake-day.fcpxml was read just now. Nothing has been imported yet.')).toBeVisible();
    await expect(checked.getByText('1 clip was switched off in the other editor and is left out.')).toBeVisible();
    await expect(checked.getByText('4 clips', { exact: true })).toBeVisible();
    await expect(checked.getByText('Kayak.mp4')).toBeVisible();
    await checked.getByRole('button', { name: 'Continue' }).click();

    const media = page.getByRole('dialog', { name: 'Find the media' });
    await expect(media.getByText('In your library as Kayak.mov')).toBeVisible();
    await expect(media.getByLabel('Use match')).toBeChecked();
    await expect(media.getByText('3 files = 1 found + 1 matched + 0 to add + 1 left as placeholders.')).toBeVisible();
    await media.getByRole('button', { name: 'Import 1 project' }).click();

    const report = page.getByRole('dialog', { name: 'Import finished' });
    await expect(report.getByText('1 project from lake-day.fcpxml is now in Studio: Lake day.')).toBeVisible();
    await expect(report.getByText('1 placeholder', { exact: true })).toBeVisible();
    await expect(report.getByRole('button', { name: 'Open in Studio' })).toBeVisible();
    expect(started).toEqual([
      {
        timelines: [0],
        media: [
          { key: 'lake', assetId: check.media[0].assetId },
          { key: 'kayak', assetId: check.media[1].assetId },
          { key: 'ridge', assetId: null },
        ],
        albumName: 'Lake day (from Final Cut Pro)',
      },
    ]);
  });
});
