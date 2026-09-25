import {
  AssetMediaResponseDto,
  getAssetInfo,
  LoginResponseDto,
  SharedLinkType,
  updateMyPreferences,
} from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Socket } from 'socket.io-client';
import { asBearerAuth, testAssetDir, utils } from 'src/utils.js';

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

    await expect(page.getByRole('button', { name: 'Information', exact: true })).toBeVisible();
    await page.keyboard.press('i');
    await expect(page.locator('#detail-panel')).toBeVisible();
    await page.keyboard.press('i');
    await expect(page.locator('#detail-panel')).toHaveCount(0);
  });

  // FL-36: a 340px floating glass card from 761px (apple-style.css:515-560); phones keep the bottom sheet.
  test('floats as a card on wide screens and becomes a bottom sheet on phones', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/photos/${asset.id}`);
    await page.waitForSelector('#immich-asset-viewer');
    await page.keyboard.press('i');
    const panel = page.locator('#detail-panel');
    await expect(panel).toBeVisible();
    const width = async () => {
      const box = await panel.boundingBox();
      return Math.round(box?.width ?? 0);
    };
    await expect.poll(width).toBe(340);
    const card = (await panel.boundingBox())!;
    expect(card.x + card.width).toBeLessThan(1280);
    expect(card.y).toBeGreaterThan(60);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(width).toBe(390);
    // The sheet slides up 24px as it appears (fl-sheet-in), so wait for it to settle on the bottom edge.
    await expect
      .poll(async () => {
        const sheet = await panel.boundingBox();
        return sheet ? Math.round(sheet.y + sheet.height) : 0;
      })
      .toBe(844);
  });

  test('cannot be opened for shared links with hidden metadata', async ({ page }) => {
    const sharedLink = await utils.createSharedLink(admin.accessToken, {
      type: SharedLinkType.Individual,
      assetIds: [asset.id],
      showMetadata: false,
    });
    await page.goto(`/share/${sharedLink.key}/photos/${asset.id}`);
    await page.waitForSelector('#immich-asset-viewer');

    await expect(page.getByRole('button', { name: 'Information', exact: true })).toHaveCount(0);
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
    await page.getByRole('button', { name: 'Information', exact: true }).click();
    await expect(textarea).toBeVisible();
    await expect(textarea).not.toBeDisabled();
  });

  test('description changes are visible after reopening', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/photos/${asset.id}`);
    await page.waitForSelector('#immich-asset-viewer');

    await page.getByRole('button', { name: 'Information', exact: true }).click();
    const textarea = page.getByRole('textbox', { name: 'Add a description' });
    await textarea.fill('new description');
    await expect(textarea).toHaveValue('new description');

    await page.getByRole('button', { name: 'Information', exact: true }).click();
    await expect(textarea).not.toBeVisible();
    await page.getByRole('button', { name: 'Information', exact: true }).click();
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

      await page.getByRole('button', { name: 'Information', exact: true }).click();
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

      await page.getByRole('button', { name: 'Information', exact: true }).click();
      const details = page.getByTestId('frameleaf-info-details');

      await expect(details.getByText('Filename', { exact: true })).toBeVisible();
      await expect(details.getByText('Path', { exact: true })).toHaveCount(0);
      await expect(details.getByText('Checksum', { exact: true })).toHaveCount(0);
    });
  });

  // FL-36: the information panel's inline edits (V-24, V-25, V-27).
  test.describe('Inline edits', () => {
    test('names the place and moves the pin from the Edit location dialog', async ({ context, page }) => {
      const located = await utils.createAsset(admin.accessToken);
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/photos/${located.id}`);
      await page.waitForSelector('#immich-asset-viewer');
      await page.getByRole('button', { name: 'Information', exact: true }).click();
      await page.getByTestId('frameleaf-info-location').getByRole('button').first().click();

      const dialog = page.getByRole('dialog', { name: 'Edit location' });
      await dialog.getByLabel('City', { exact: true }).fill('Banff');
      await dialog.getByLabel('Country', { exact: true }).fill('Canada');
      await dialog.getByLabel('Latitude', { exact: true }).fill('51.1784');
      await dialog.getByLabel('Longitude', { exact: true }).fill('-115.5708');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);

      await expect
        .poll(
          async () => (await getAssetInfo({ id: located.id }, { headers: asBearerAuth(admin.accessToken) })).exifInfo,
        )
        .toMatchObject({ city: 'Banff', country: 'Canada', latitude: 51.1784, longitude: -115.5708 });
      await expect(page.getByTestId('frameleaf-info-location')).toContainText('Banff');
    });

    test('adds, creates and removes tags in place, and T opens the tag box', async ({ context, page }) => {
      const tagged = await utils.createAsset(admin.accessToken);
      await updateMyPreferences(
        { userPreferencesUpdateDto: { tags: { enabled: true } } },
        { headers: asBearerAuth(admin.accessToken) },
      );
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/photos/${tagged.id}`);
      await page.waitForSelector('#immich-asset-viewer');

      await page.keyboard.press('t');
      const box = page.getByRole('combobox', { name: 'Add a tag' });
      await expect(box).toBeFocused();
      const section = page.getByTestId('detail-panel-tags');
      await expect(section.getByText('No tags yet.')).toBeVisible();

      await box.fill('Trips');
      await page.getByRole('option', { name: 'Create “Trips”' }).click();
      await expect(section.getByRole('link', { name: 'Trips' })).toBeVisible();

      await section.getByRole('button', { name: 'Remove tag Trips' }).click();
      await expect(section.getByText('No tags yet.')).toBeVisible();
    });

    test("names the owner of a partner's item", async ({ context, page }) => {
      const partner = await utils.userSetup(admin.accessToken, {
        email: 'owner-line@immich.cloud',
        name: 'Avery Partner',
        password: 'password',
      });
      const partnerAsset = await utils.createAsset(partner.accessToken);
      await utils.createPartner(partner.accessToken, admin.userId);

      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/photos/${partnerAsset.id}`);
      await page.waitForSelector('#immich-asset-viewer');
      await page.getByRole('button', { name: 'Information', exact: true }).click();
      await expect(page.getByTestId('detail-panel-owner')).toHaveText('Owned by Avery Partner');
    });
  });

  test.describe('Date editor', () => {
    test('displays inferred asset timezone', async ({ context, page }) => {
      const test = {
        filepath: 'metadata/dates/datetimeoriginal-gps.jpg',
        expected: {
          date: '2025-12-01',
          time: '11:30',
          // Test with a timezone which is NOT the first among timezones with the same offset
          // This is to check that the editor does not simply fall back to the first available timezone with that offset
          // America/Denver (-07:00) is not the first among timezones with offset -07:00
          timeZone: 'America/Denver',
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

      await page.getByRole('button', { name: 'Information', exact: true }).click();
      await page.getByTestId('detail-panel-edit-date-button').click();
      await page.waitForSelector('[role="dialog"]');

      // V-23: the template's "Edit date and time" dialog: date, time, and a time zone that keeps the current one
      const dialog = page.getByRole('dialog', { name: 'Edit date and time' });
      await expect(dialog.getByLabel('Date', { exact: true })).toHaveValue(test.expected.date);
      await expect(dialog.getByLabel('Time', { exact: true })).toHaveValue(test.expected.time);
      const timeZone = dialog.getByLabel('Time zone', { exact: true });
      await expect(timeZone).toHaveValue('');
      await expect(timeZone.locator('option').first()).toHaveText('Keep the current time zone');
      await expect(timeZone.locator(`option[value="${test.expected.timeZone}"]`)).toHaveCount(1);
      await expect(dialog.getByText(/^Capture time becomes /)).toBeVisible();
    });

    test('saves a new capture time from the dialog', async ({ context, page }) => {
      const asset = await utils.createAsset(admin.accessToken);
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/photos/${asset.id}`);
      await page.waitForSelector('#immich-asset-viewer');
      await page.getByRole('button', { name: 'Information', exact: true }).click();
      await page.getByTestId('detail-panel-edit-date-button').click();

      const dialog = page.getByRole('dialog', { name: 'Edit date and time' });
      await dialog.getByLabel('Date', { exact: true }).fill('2024-03-05');
      await dialog.getByLabel('Time', { exact: true }).fill('09:15');
      await dialog.getByLabel('Time zone', { exact: true }).selectOption('UTC');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);

      await expect
        .poll(
          async () =>
            (await getAssetInfo({ id: asset.id }, { headers: asBearerAuth(admin.accessToken) })).exifInfo
              ?.dateTimeOriginal,
        )
        .toMatch(/^2024-03-05T09:15:00/);
    });

    // FL-83 (ported from abe5d9e470, b832bb19bd, 6b68cfbfe2): a failed lock keeps everything behind the
    // root shield with Retry; a successful retry closes private editors and dialogs, then replaces the
    // whole document (the PR131 boundary) before anything is revealed again.
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
      await page.getByRole('button', { name: 'Information', exact: true }).click();
      await page.getByTestId('detail-panel-edit-date-button').click();
      await expect(page.locator('input[type="date"]')).toBeVisible();
      // The open date modal hides the rest of the page from the accessibility tree, top bar included.
      const lock = page.getByRole('button', { name: 'Hide Locked content', includeHidden: true }).first();
      await expect(lock).toBeAttached();

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
      await expect.poll(() => attempts).toBe(1);
      await expect(page.locator('input[type="date"]')).toBeHidden();
      await expect
        .poll(() => page.evaluate(() => sessionStorage.getItem('frameleaf:session-lock-pending')))
        .toBe('true');

      await page.getByRole('button', { name: 'Retry', exact: true }).click({ timeout: 3000 });
      await expect.poll(() => attempts).toBe(2);
      await expect.poll(() => lockStatuses).toContain(204);
      await expect(page).toHaveURL(/\/photos(?:\?|$)/);
      await expect(shield).toHaveCount(0);
      await expect(page.locator('input[type="date"]')).toHaveCount(0);
      await expect(nativeDialog).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem('frameleaf:session-lock-pending'))).toBeNull();
    });

    test('offers lock retry on the PIN prompt without a top bar', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto('/auth/pin-prompt');
      await page.evaluate(() => sessionStorage.setItem('frameleaf:session-lock-pending', 'true'));
      let attempts = 0;
      await page.route('**/api/auth/session/lock', async (route) => {
        attempts++;
        if (attempts === 1) {
          await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"offline"}' });
        } else {
          await route.continue();
        }
      });
      await page.reload();
      await expect.poll(() => attempts).toBe(1);
      await expect(page.locator('#dashboard-navbar')).toHaveCount(0);
      await expect(page.locator('dialog.session-lock-shield[open]')).toHaveCount(1);

      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect.poll(() => attempts).toBe(2);
      await expect(page.locator('dialog.session-lock-shield[open]')).toHaveCount(0);
      // the PIN prompt is already a locked-only page: the lock settles in place, without a reload
      await expect(page).toHaveURL(/\/auth\/pin-prompt/);
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem('frameleaf:session-lock-pending'))).toBeNull();
    });
  });
});
