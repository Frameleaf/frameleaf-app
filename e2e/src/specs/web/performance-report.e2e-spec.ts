import { LoginResponseDto } from '@frameleaf/sdk';
import { expect, test } from '@playwright/test';
import { utils } from 'src/utils.js';

/**
 * FL-139 (QA-103): wall-clock web performance, recorded on every CI run and never asserted. The owner
 * decided these are reported, not gated, until reference hardware is defined: CI runners vary too much
 * for a threshold to mean anything. The numbers are attached to the Playwright report as
 * `performance-report.json`, which CI archives per runner (e2e-web-test-results-*).
 *
 * Recorded: the library's startup (navigation to DOMContentLoaded and load), time to the first
 * thumbnail on screen, and frames during a scroll of the timeline (long frames over 50 ms).
 */
const LIBRARY_ITEMS = 200;

test.describe('performance report (FL-139)', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    for (let index = 0; index < LIBRARY_ITEMS; index++) {
      await utils.createAsset(admin.accessToken);
    }
    await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');
  });

  test('records startup, first thumbnail and scrolling on the library', async ({ context, page }) => {
    test.setTimeout(120_000);
    await utils.setAuthCookies(context, admin.accessToken);

    const started = Date.now();
    await page.goto('/photos');
    await page.locator('[data-asset-id] img').first().waitFor({ state: 'visible' });
    const firstThumbnailMs = Date.now() - started;

    const navigation = await page.evaluate(() => {
      const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      return { domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd), loadMs: Math.round(entry.loadEventEnd) };
    });

    // frames during a scroll to the end of the timeline and back
    const scroll = await page.evaluate(async () => {
      const frames: number[] = [];
      let last = performance.now();
      let running = true;
      const tick = (now: number) => {
        frames.push(now - last);
        last = now;
        if (running) {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
      const scroller =
        [...document.querySelectorAll<HTMLElement>('*')].find(
          (element) =>
            element.scrollHeight > element.clientHeight + 200 && getComputedStyle(element).overflowY !== 'visible',
        ) ?? document.scrollingElement!;
      for (const target of [scroller.scrollHeight, 0]) {
        const from = scroller.scrollTop;
        for (let step = 1; step <= 30; step++) {
          scroller.scrollTop = from + ((target - from) * step) / 30;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }
      running = false;
      const sorted = frames.slice(1).toSorted((a, b) => a - b);
      return {
        frames: sorted.length,
        longFrames: sorted.filter((frame) => frame > 50).length,
        medianFrameMs: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
        worstFrameMs: Math.round(sorted.at(-1) ?? 0),
      };
    });

    const report = {
      recordedAt: new Date().toISOString(),
      libraryItems: LIBRARY_ITEMS,
      startup: navigation,
      firstThumbnailMs,
      scroll,
    };
    await test.info().attach('performance-report.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    test.info().annotations.push({ type: 'performance', description: JSON.stringify(report) });

    // recorded, not asserted: only check that each measurement was taken
    expect(firstThumbnailMs).toBeGreaterThan(0);
    expect(scroll.frames).toBeGreaterThan(0);
  });
});
