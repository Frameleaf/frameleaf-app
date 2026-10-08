import { getAssetInfo, getNotifications, lockAssets, setUserOnboarding } from '@frameleaf/sdk';
import { expect, test, type Page } from '@playwright/test';
import { asBearerAuth, baseUrl, utils } from 'src/utils.js';

// Normal page fetch, including the browser/service-worker cache; consume the whole media body.
const mediaStatus = (page: Page, id: string, kind: 'thumbnail' | 'original') =>
  page.evaluate(async (url) => {
    const response = await fetch(url);
    await response.arrayBuffer();
    return response.status;
  }, `/api/assets/${id}/${kind}`);

test('shares one item with a person and removes it when the owner revokes access (FL-198)', async ({ browser }) => {
  test.setTimeout(120_000);
  utils.initSdk();
  await utils.resetDatabase();
  const owner = await utils.adminSetup();
  const recipient = await utils.userSetup(owner.accessToken, {
    name: 'Jamie Recipient',
    email: 'item-share-recipient@example.com',
    password: 'password',
  });
  await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(recipient.accessToken) });
  const shared = await utils.createAsset(owner.accessToken, { assetData: { filename: 'shared-fl198.png' } });
  const privateAsset = await utils.createAsset(owner.accessToken, { assetData: { filename: 'private-fl198.png' } });

  const ownerContext = await browser.newContext({ baseURL: baseUrl });
  const recipientContext = await browser.newContext({ baseURL: baseUrl });
  try {
    await utils.setAuthCookies(ownerContext, owner.accessToken);
    await utils.setAuthCookies(recipientContext, recipient.accessToken);
    const ownerPage = await ownerContext.newPage();
    const recipientPage = await recipientContext.newPage();

    await ownerPage.goto(`/photos/${shared.id}`);
    const share = ownerPage.getByTestId('asset-viewer-navbar-actions').getByRole('button', { name: 'Share' });
    await share.click();
    // ShareSheet.svelte titles the sheet by what is shared ("Share 1 photo"), not by a file name.
    const sheet = ownerPage.getByRole('dialog', { name: 'Share 1 photo' });
    await expect(sheet.getByRole('radio', { name: /Share with people in this library/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const jamie = sheet.getByRole('group', { name: 'People to share with' }).getByRole('button', {
      name: 'Jamie Recipient',
    });
    await expect(jamie).toHaveAttribute('aria-pressed', 'false');
    await jamie.focus();
    await ownerPage.keyboard.press('Space');
    await expect(jamie).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByRole('button', { name: 'Share with Jamie Recipient' }).click();
    await expect(sheet).toHaveCount(0);

    await recipientPage.goto('/sharing?section=shared-with-you');
    await recipientPage.waitForFunction(() => !!navigator.serviceWorker?.controller, undefined, { timeout: 30_000 });
    const received = recipientPage.getByRole('region', { name: 'Shared with you' });
    const tile = received.getByRole('button', { name: 'shared-fl198.png' });
    await expect(tile).toBeVisible();
    await expect(received.getByRole('listitem')).toHaveCount(1);
    await expect(received.getByRole('button', { name: 'private-fl198.png' })).toHaveCount(0);
    await expect.poll(() => mediaStatus(recipientPage, shared.id, 'thumbnail'), { timeout: 30_000 }).toBe(200);
    expect(await mediaStatus(recipientPage, shared.id, 'original')).toBe(200);
    await expect
      .poll(
        async () => {
          const notifications = await getNotifications({}, { headers: asBearerAuth(recipient.accessToken) });
          return notifications.some(({ type, title }) => type === 'ItemShare' && title === 'Shared with you');
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    await expect(
      getAssetInfo({ id: shared.id }, { headers: asBearerAuth(recipient.accessToken) }),
    ).resolves.toMatchObject({ id: shared.id });
    await expect(
      getAssetInfo({ id: privateAsset.id }, { headers: asBearerAuth(recipient.accessToken) }),
    ).rejects.toMatchObject({ status: 400 });
    await tile.click();
    const viewer = recipientPage.locator('#immich-asset-viewer');
    await expect(viewer).toHaveAttribute('data-asset-id', shared.id);

    await share.click();
    await expect(jamie).toHaveAttribute('aria-pressed', 'true');
    await jamie.click();
    // the primary button names the change it will make
    await sheet.getByRole('button', { name: 'Stop sharing with Jamie Recipient' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(viewer).toHaveCount(0);
    expect(await mediaStatus(recipientPage, shared.id, 'thumbnail')).toBe(400);
    expect(await mediaStatus(recipientPage, shared.id, 'original')).toBe(404);
    await expect(tile).toHaveCount(0);
    await expect(received.getByRole('status')).toHaveText('Nothing has been shared with you yet.');
    await recipientPage.reload();
    await expect(received.getByRole('status')).toHaveText('Nothing has been shared with you yet.');
    await expect(
      getAssetInfo({ id: shared.id }, { headers: asBearerAuth(recipient.accessToken) }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(getAssetInfo({ id: shared.id }, { headers: asBearerAuth(owner.accessToken) })).resolves.toMatchObject({
      id: shared.id,
    });

    // Regrant through the real sheet, then Lock through the real owner API. An open recipient
    // mirror must retire from the assetHidden event, and normal cached media reads must be denied.
    await share.click();
    await expect(jamie).toHaveAttribute('aria-pressed', 'false');
    await jamie.focus();
    await ownerPage.keyboard.press('Space');
    await sheet.getByRole('button', { name: 'Share with Jamie Recipient' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(tile).toBeVisible();
    await tile.click();
    await expect(viewer).toHaveAttribute('data-asset-id', shared.id);
    await recipientPage.waitForFunction(() => !!navigator.serviceWorker?.controller, undefined, { timeout: 30_000 });
    expect(await mediaStatus(recipientPage, shared.id, 'thumbnail')).toBe(200);
    expect(await mediaStatus(recipientPage, shared.id, 'original')).toBe(200);
    await lockAssets({ bulkIdsDto: { ids: [shared.id] } }, { headers: asBearerAuth(owner.accessToken) });
    await expect(viewer).toHaveCount(0);
    await expect(tile).toHaveCount(0);
    await expect(received.getByRole('status')).toHaveText('Nothing has been shared with you yet.');
    expect(await mediaStatus(recipientPage, shared.id, 'thumbnail')).toBe(400);
    expect(await mediaStatus(recipientPage, shared.id, 'original')).toBe(404);
    await expect(
      getAssetInfo({ id: shared.id }, { headers: asBearerAuth(recipient.accessToken) }),
    ).rejects.toMatchObject({ status: 400 });
    await recipientPage.reload();
    await expect(received.getByRole('status')).toHaveText('Nothing has been shared with you yet.');
  } finally {
    await ownerContext.close();
    await recipientContext.close();
  }
});
