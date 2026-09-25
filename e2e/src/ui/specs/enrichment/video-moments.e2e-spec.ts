import { expect, Page, test } from '@playwright/test';
import type { TimelineAssetConfig } from 'src/ui/generators/timeline.js';
import { setupAssetViewerFixture } from '../asset-viewer/utils';
import { assetViewerUtils } from '../timeline/utils';

/**
 * A video's moments (FL-59, `REC-101`) in the viewer's information panel, against a mocked server:
 * the reusable frames ranked best first, choosing a cover, and frame-to-moment search from a frame's
 * stored embedding, whose hit in another video opens that video. No speech transcription request.
 */
const frame = (videoId: string, index: number, rank: number, isCover = false) => ({
  id: `f${index}-${videoId}`.slice(0, 36),
  frameIndex: index,
  rank,
  score: 1 - rank / 10,
  timestampMs: index * 2000,
  width: 640,
  height: 360,
  indexed: true,
  isCover,
});

const openMoments = async (page: Page, asset: TimelineAssetConfig) => {
  await page.goto(`/photos/${asset.id}`);
  await assetViewerUtils.waitForViewerLoad(page, asset);
  await page.keyboard.press('i');
  await page.locator('#detail-panel').waitFor({ state: 'visible' });
  const panel = page.getByTestId('frameleaf-video-moments');
  await expect(panel).toBeVisible();
  return panel;
};

test.describe.configure({ mode: 'parallel' });
test.describe('video moments', () => {
  const fixture = setupAssetViewerFixture(59);
  const requests = { all: [] as string[], covers: [] as unknown[], similar: [] as string[] };

  const videos = () => fixture.assets.filter((asset) => asset.isVideo);

  test.beforeEach(async ({ context }) => {
    requests.all = [];
    requests.covers = [];
    requests.similar = [];
    const [video, other] = videos();
    expect(other, 'the seeded timeline has at least two videos').toBeDefined();
    const frames = [frame(video.id, 0, 3), frame(video.id, 1, 1), frame(video.id, 2, 2)];
    let coverTimestampMs: number | null = null;

    context.on('request', (request) => {
      requests.all.push(new URL(request.url()).pathname);
    });
    await context.route(
      (url) => /\/api\/enrichment\/frames\/[^/]+$/.test(url.pathname),
      (route) => route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.alloc(0) }),
    );
    const moments = () => ({
      assetId: video.id,
      state: 'ready',
      staleReason: null,
      frames: frames.map((item) => ({ ...item, isCover: item.timestampMs === coverTimestampMs })),
      moments: [],
      coverFrameId: frames.find((item) => item.timestampMs === coverTimestampMs)?.id ?? null,
      coverTimestampMs,
      framesExtractedAt: '2026-09-24T10:00:00.000Z',
      indexedAt: '2026-09-24T10:01:00.000Z',
      captionedAt: null,
      captionModel: null,
      embeddingModel: 'ViT-B-32__openai',
      extractorVersion: '1',
    });
    await context.route('**/api/enrichment/videos/*/moments', (route, request) => {
      const id = new URL(request.url()).pathname.split('/').at(-2);
      return id === video.id ? route.fulfill({ json: moments() }) : route.fulfill({ status: 404, json: {} });
    });
    await context.route('**/api/enrichment/videos/*/cover', (route, request) => {
      const body = request.postDataJSON() as { timestampMs: number | null };
      requests.covers.push(body);
      coverTimestampMs = body.timestampMs;
      return route.fulfill({ json: moments() });
    });
    await context.route('**/api/enrichment/frames/*/similar*', (route, request) => {
      requests.similar.push(new URL(request.url()).pathname.split('/').at(-2)!);
      return route.fulfill({
        json: {
          hits: [
            {
              assetId: other.id,
              frameId: null,
              momentId: null,
              caption: null,
              match: 'visual',
              score: 0.92,
              timestampMs: 64_000,
            },
          ],
        },
      });
    });
  });

  test('ranks the frames best first and chooses one as the cover', async ({ page }) => {
    const [video] = videos();
    const panel = await openMoments(page, video);

    const frames = panel.getByRole('list', { name: 'Frames, best first' });
    await expect(frames.getByRole('button', { name: /^Play from/ }).first()).toHaveAccessibleName('Play from 0:02');
    await expect(frames.getByText('Best')).toHaveCount(1);

    await frames.getByRole('button', { name: 'Use as cover' }).first().click();
    await expect.poll(() => requests.covers).toEqual([{ timestampMs: 2000 }]);
    await expect(panel.getByText('Cover frame at 0:02')).toBeVisible();
  });

  test('finds moments like a frame and opens a hit in another video', async ({ page }) => {
    const [video, other] = videos();
    const panel = await openMoments(page, video);

    await panel.getByRole('button', { name: 'Find moments like 0:02' }).click();
    await expect.poll(() => requests.similar).toHaveLength(1);
    const results = panel.getByTestId('frameleaf-similar-moments');
    await expect(results.getByRole('region', { name: 'Moments like 0:02' })).toBeVisible();

    await results.getByRole('button', { name: 'Play from 1:04' }).click();
    await page.waitForURL(`**/photos/${other.id}`);

    expect(requests.all.filter((path) => /transcri|asr|speech/i.test(path))).toEqual([]);
  });
});
