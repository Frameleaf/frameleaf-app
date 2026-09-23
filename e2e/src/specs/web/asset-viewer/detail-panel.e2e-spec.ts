import { AssetMediaResponseDto, AssetVisibility, LoginResponseDto, SharedLinkType } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Socket } from 'socket.io-client';
import { testAssetDir, utils } from 'src/utils.js';

test.describe('Detail Panel', () => {
  let admin: LoginResponseDto;
  let asset: AssetMediaResponseDto;
  let websocket: Socket;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    asset = await utils.createAsset(admin.accessToken);
    websocket = await utils.connectWebsocket(admin.accessToken);
  });

  test.afterAll(() => {
    utils.disconnectWebsocket(websocket);
  });

  test('can be opened for shared links', async ({ page }) => {
    const sharedLink = await utils.createSharedLink(admin.accessToken, {
      type: SharedLinkType.Individual,
      assetIds: [asset.id],
    });
    await page.goto(`/share/${sharedLink.key}/photos/${asset.id}`);
    await page.waitForSelector('#immich-asset-viewer');

    await expect(page.getByRole('button', { name: 'Info' })).toBeVisible();
    await page.keyboard.press('i');
    await expect(page.locator('#detail-panel')).toBeVisible();
    await page.keyboard.press('i');
    await expect(page.locator('#detail-panel')).toHaveCount(0);
  });

  test('cannot be opened for shared links with hidden metadata', async ({ page }) => {
    const sharedLink = await utils.createSharedLink(admin.accessToken, {
      type: SharedLinkType.Individual,
      assetIds: [asset.id],
      showMetadata: false,
    });
    await page.goto(`/share/${sharedLink.key}/photos/${asset.id}`);
    await page.waitForSelector('#immich-asset-viewer');

    await expect(page.getByRole('button', { name: 'Info' })).toHaveCount(0);
    await page.keyboard.press('i');
    await expect(page.locator('#detail-panel')).toHaveCount(0);
    await page.keyboard.press('i');
    await expect(page.locator('#detail-panel')).toHaveCount(0);
  });

  test('description is visible for owner on shared links', async ({ context, page }) => {
    const sharedLink = await utils.createSharedLink(admin.accessToken, {
      type: SharedLinkType.Individual,
      assetIds: [asset.id],
    });
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/share/${sharedLink.key}/photos/${asset.id}`);

    const textarea = page.getByRole('textbox', { name: 'Add a description' });
    await page.getByRole('button', { name: 'Info' }).click();
    await expect(textarea).toBeVisible();
    await expect(textarea).not.toBeDisabled();
  });

  test('description changes are visible after reopening', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/photos/${asset.id}`);
    await page.waitForSelector('#immich-asset-viewer');

    await page.getByRole('button', { name: 'Info' }).click();
    const textarea = page.getByRole('textbox', { name: 'Add a description' });
    await textarea.fill('new description');
    await expect(textarea).toHaveValue('new description');

    await page.getByRole('button', { name: 'Info' }).click();
    await expect(textarea).not.toBeVisible();
    await page.getByRole('button', { name: 'Info' }).click();
    await expect(textarea).toBeVisible();

    await utils.waitForWebsocketEvent({ event: 'assetUpdate', id: asset.id });
    await expect(textarea).toHaveValue('new description');
  });

  // FL-36: the information panel's Details list. The path and the checksum are storage facts
  // about the owner's own library, so they are absent for anyone else rather than shown empty.
  test.describe('Details', () => {
    test('shows the file, path and checksum rows to the owner', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/photos/${asset.id}`);
      await page.waitForSelector('#immich-asset-viewer');

      await page.getByRole('button', { name: 'Info' }).click();
      const details = page.getByTestId('frameleaf-info-details');

      await expect(details.getByText('Filename', { exact: true })).toBeVisible();
      await expect(details.getByText('Path', { exact: true })).toBeVisible();
      await expect(details.getByText('Checksum', { exact: true })).toBeVisible();
    });

    test('omits the path and the checksum for a shared-link visitor', async ({ page }) => {
      const sharedLink = await utils.createSharedLink(admin.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
      });
      await page.goto(`/share/${sharedLink.key}/photos/${asset.id}`);
      await page.waitForSelector('#immich-asset-viewer');

      await page.getByRole('button', { name: 'Info' }).click();
      const details = page.getByTestId('frameleaf-info-details');

      await expect(details.getByText('Filename', { exact: true })).toBeVisible();
      await expect(details.getByText('Path', { exact: true })).toHaveCount(0);
      await expect(details.getByText('Checksum', { exact: true })).toHaveCount(0);
    });
  });

  test.describe('Date editor', () => {
    test('displays inferred asset timezone', async ({ context, page }) => {
      const test = {
        filepath: 'metadata/dates/datetimeoriginal-gps.jpg',
        expected: {
          dateTime: '2025-12-01T11:30',
          // Test with a timezone which is NOT the first among timezones with the same offset
          // This is to check that the editor does not simply fall back to the first available timezone with that offset
          // America/Denver (-07:00) is not the first among timezones with offset -07:00
          timeZoneWithOffset: 'America/Denver (-07:00)',
        },
      };

      const asset = await utils.createAsset(admin.accessToken, {
        assetData: {
          bytes: await readFile(join(testAssetDir, test.filepath)),
          filename: basename(test.filepath),
        },
      });

      await utils.waitForWebsocketEvent({ event: 'assetUpload', id: asset.id });

      // asset viewer -> detail panel -> date editor
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/photos/${asset.id}`);
      await page.waitForSelector('#immich-asset-viewer');

      await page.getByRole('button', { name: 'Info' }).click();
      await page.getByTestId('detail-panel-edit-date-button').click();
      await page.waitForSelector('[role="dialog"]');

      const datetime = page.locator('#datetime');
      await expect(datetime).toHaveValue(test.expected.dateTime);
      const timezone = page.getByRole('combobox', { name: 'Timezone' });
      await expect(timezone).toHaveValue(test.expected.timeZoneWithOffset);
    });

    test('retries a failed lock above native modality and closes private editors before revealing the app', async ({
      context,
      page,
    }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      const pin = { pinCode: '123456' };
      const pinSetup = await page.request.post('/api/auth/pin-code', { data: pin });
      if (!pinSetup.ok()) {
        expect(pinSetup.status()).toBe(400);
        expect(await pinSetup.text()).toContain('User already has a PIN code');
      }
      const unlocked = await page.request.post('/api/auth/session/unlock', { data: pin });
      expect(unlocked.ok()).toBe(true);
      await page.goto(`/photos/${asset.id}`);
      await page.waitForSelector('#immich-asset-viewer');
      await page.getByRole('button', { name: 'Info' }).click();
      await page.getByTestId('detail-panel-edit-date-button').click();
      await expect(page.locator('#datetime')).toBeVisible();
      // The editor is body-mounted and survives this in-app viewer navigation.
      await page
        .getByRole('button', { name: 'Close viewer (Escape)' })
        .evaluate((button: HTMLButtonElement) => button.click());
      await expect(page).toHaveURL(/\/photos(?:\?|$)/);
      await expect(page.locator('#datetime')).toBeVisible();
      const lock = page.getByRole('button', { name: 'Hide Locked content' }).first();
      await expect(lock).toBeVisible();

      await page.evaluate(() => {
        const dialog = document.createElement('dialog');
        dialog.id = 'native-dialog-during-lock';
        dialog.textContent = 'Private dialog draft';
        document.body.append(dialog);
        dialog.showModal();
      });
      const nativeDialog = page.locator('#native-dialog-during-lock');
      await expect(nativeDialog).toHaveJSProperty('open', true);

      let attempts = 0;
      const lockStatuses: number[] = [];
      page.on('response', (response) => {
        if (response.url().endsWith('/api/auth/session/lock')) {
          lockStatuses.push(response.status());
        }
      });
      await page.route('**/api/auth/session/lock', async (route) => {
        attempts++;
        if (attempts === 1) {
          await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"offline"}' });
        } else {
          await route.continue();
        }
      });
      // The native dialog blocks ordinary controls, so trigger the same lock handler as tab hiding.
      await lock.evaluate((button: HTMLButtonElement) => button.click());
      const shield = page.locator('dialog.session-lock-shield[open]');
      await expect(shield).toHaveCount(1);
      await expect(shield).toHaveJSProperty('open', true);
      await expect.poll(() => attempts).toBe(1);
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '#dashboard-navbar [aria-label="Unlock Locked content"]',
        );
        return button && !button.disabled;
      });

      const retry = page.getByRole('button', { name: 'Retry', exact: true });
      await retry.click({ timeout: 3000 });
      await expect.poll(() => attempts).toBe(2);
      await expect.poll(() => lockStatuses).toContain(204);
      await expect(shield).toHaveCount(0);
      await expect(page.locator('#datetime')).toHaveCount(0);
      await expect(nativeDialog).toHaveJSProperty('open', false);
    });

    test('hides a locked asset filename from an open delete confirmation when the tab locks', async ({
      context,
      page,
    }) => {
      const lockedAsset = await utils.createAsset(admin.accessToken, {
        visibility: AssetVisibility.Locked,
        assetData: { filename: 'private-lock-repro.png' },
      });
      await utils.setAuthCookies(context, admin.accessToken);
      const pin = { pinCode: '123456' };
      const pinSetup = await page.request.post('/api/auth/pin-code', { data: pin });
      if (!pinSetup.ok()) {
        expect(pinSetup.status()).toBe(400);
        expect(await pinSetup.text()).toContain('User already has a PIN code');
      }
      const unlocked = await page.request.post('/api/auth/session/unlock', { data: pin });
      expect(unlocked.ok()).toBe(true);
      await page.goto(`/photos/${lockedAsset.id}`);
      await page.waitForSelector('#immich-asset-viewer');
      await page.keyboard.press('Shift+Delete');
      const confirmation = page.locator('[role="dialog"]').filter({ hasText: 'private-lock-repro.png' });
      await expect(confirmation).toBeVisible();

      const lockStatuses: number[] = [];
      page.on('response', (response) => {
        if (response.url().endsWith('/api/auth/session/lock')) {
          lockStatuses.push(response.status());
        }
      });
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect.poll(() => lockStatuses).toContain(204);
      await expect(page.locator('dialog.session-lock-shield[open]')).toHaveCount(0);
      await expect(confirmation).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('private-lock-repro.png');
      await expect(page).toHaveURL(/\/photos(?:\?|$)/);
    });
  });
});
