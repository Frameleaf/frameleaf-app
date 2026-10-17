import { expect, test, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, testAssetDir, utils } from 'src/utils.js';

const insideViewport = async (control: Locator, width: number, height: number) => {
  await expect(control).toBeVisible();
  const bounds = await control.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
  expect(bounds!.height).toBeGreaterThanOrEqual(width === 390 ? 44 : 38);
};

test.describe('Shared editor Save and Cancel reachability (FL-144)', () => {
  test.describe.configure({ mode: 'serial' });
  for (const kind of ['photo', 'video'] as const) {
    test(`${kind} keeps normal Save and Cancel fully visible on desktop and at 390px`, async ({
      context,
      page,
    }, testInfo) => {
      test.setTimeout(180_000);
      utils.initSdk();
      await utils.resetDatabase();
      const owner = await utils.adminSetup();
      // Real existing H.264 fixture, never the PNG-disguised-as-video convenience fixture.
      const asset = await utils.createAsset(
        owner.accessToken,
        kind === 'video'
          ? {
              assetData: {
                filename: 'eiffel-tower.mp4',
                bytes: await readFile(join(testAssetDir, 'videos/eiffel-tower.mp4')),
              },
            }
          : undefined,
      );
      await utils.waitForQueueFinish(owner.accessToken, 'metadataExtraction', 60_000);
      await utils.waitForQueueFinish(owner.accessToken, 'thumbnailGeneration', 60_000);
      await utils.setAuthCookies(context, owner.accessToken);
      const endpoint = `${app}/assets/${asset.id}/${kind === 'photo' ? 'develop' : 'edits'}`;
      const read = async () => {
        const response = await context.request.get(endpoint);
        expect(response.status()).toBe(200);
        return response.json();
      };
      let failure: unknown;
      let failed = false;
      try {
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 844 });
          if (width === 1280) {
            await page.goto(`/photos/${asset.id}`);
          }
          // Resize the same normal viewer; full-reload continuity is a separate acceptance seam.
          await page
            .getByRole('button', { name: /^(Edit|Edit video)$/ })
            .filter({ visible: true })
            .first()
            .click();
          const editor = page.getByRole('dialog', { name: /^Edit / });
          const save = editor.getByRole('button', { name: 'Save version', exact: true });
          const cancel = editor.locator('.ed-top button[title="Cancel and close editor"]');
          // Both full hitboxes must already fit; Playwright must not scroll clipped commands into view.
          await insideViewport(save, width, 844);
          await insideViewport(cancel, width, 844);
          const top = await editor.locator('.ed-top').boundingBox();
          if (width === 1280) {
            expect(top!.height).toBe(56);
          }
          if (kind === 'photo') {
            await editor.getByRole('slider', { name: 'Contrast', exact: true }).fill(width === 1280 ? '10' : '20');
          } else {
            await editor.getByRole('tab', { name: 'Speed', exact: true }).click();
            await editor.getByRole('radio', { name: width === 1280 ? '2×' : '0.5×', exact: true }).click();
          }
          await expect(save).toBeEnabled();
          const savedPromise = page.waitForResponse(
            (response) => response.url() === endpoint && response.request().method() === 'PUT',
          );
          await testInfo.attach(`${kind}-${width}-toolbar`, {
            body: await page.screenshot(),
            contentType: 'image/png',
          });
          await save.click();
          const savedResponse = await savedPromise;
          expect(savedResponse.status()).toBe(200);
          const saved = await savedResponse.json();
          await expect(editor).toBeHidden();
          if (kind === 'photo') {
            await expect
              .poll(
                async () => {
                  const state = await read();
                  return {
                    current: state.currentRevisionId,
                    status: state.revisions.find((revision: { id: string }) => revision.id === saved.id)?.status,
                  };
                },
                { timeout: 60_000 },
              )
              .toEqual({ current: saved.id, status: 'rendered' });
          } else {
            // Durable normal API edit acceptance, not a claim that a queued video render completed.
            expect(saved.edits.length).toBeGreaterThan(0);
          }
          const persisted = await read();
          await page
            .getByRole('button', { name: /^(Edit|Edit video)$/ })
            .filter({ visible: true })
            .first()
            .click();
          await expect(editor).toBeVisible();
          await insideViewport(save, width, 844);
          await insideViewport(cancel, width, 844);
          if (kind === 'photo') {
            await expect(editor.getByRole('slider', { name: 'Contrast', exact: true })).toHaveValue(
              width === 1280 ? '10' : '20',
            );
          } else {
            await editor.getByRole('tab', { name: 'Speed', exact: true }).click();
            await expect(
              editor.getByRole('radio', { name: width === 1280 ? '2×' : '0.5×', exact: true }),
            ).toHaveAttribute('aria-checked', 'true');
          }
          // Cancel a real unsaved change without adding a revision or replacing stored video edits.
          if (kind === 'photo') {
            await editor.getByRole('slider', { name: 'Contrast', exact: true }).fill('30');
          } else {
            await editor.getByRole('radio', { name: '1×', exact: true }).click();
          }
          await cancel.click();
          await expect(editor).toBeHidden();
          const afterCancel = await read();
          expect(kind === 'photo' ? afterCancel.revisions : afterCancel.edits).toEqual(
            kind === 'photo' ? persisted.revisions : persisted.edits,
          );
        }
      } catch (error) {
        failure = error;
        failed = true;
      } finally {
        if (kind === 'video') {
          // Saving admits a render that cannot be cancelled once started. Join it even if an assertion failed.
          try {
            await utils.waitForQueueFinish(owner.accessToken, 'videoConversion', 60_000);
          } catch (error) {
            failure = failed
              ? new AggregateError([failure, error], 'Editor assertions and video render settlement failed', {
                  cause: failure,
                })
              : error;
            failed = true;
          }
        }
      }
      if (failed) {
        throw failure;
      }
    });
  }
});
