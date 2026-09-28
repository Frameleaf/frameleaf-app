import { getAssetInfo, setUserOnboarding } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, baseUrl, utils } from 'src/utils.js';

test('shares one item with a person and removes it when the owner revokes access (FL-198)', async ({ browser }) => {
  test.setTimeout(90_000);
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
    const sheet = ownerPage.getByRole('dialog', { name: 'Share 1 item' });
    await expect(sheet.getByRole('radio', { name: /Share with people in this library/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const jamie = sheet.getByRole('group', { name: 'People to share with' }).getByRole('button', {
      name: 'Jamie Recipient',
    });
    await expect(jamie).toHaveAttribute('aria-pressed', 'false');
    await jamie.click();
    await sheet.getByRole('button', { name: 'Share with Jamie Recipient' }).click();
    await expect(sheet).toHaveCount(0);

    await recipientPage.goto('/sharing?section=shared-with-you');
    const received = recipientPage.getByRole('region', { name: 'Shared with you' });
    const tile = received.getByRole('button', { name: 'shared-fl198.png' });
    await expect(tile).toBeVisible();
    await expect(received.getByRole('listitem')).toHaveCount(1);
    await expect(received.getByRole('button', { name: 'private-fl198.png' })).toHaveCount(0);
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
    await sheet.getByRole('button', { name: 'Save sharing' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(viewer).toHaveCount(0);
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
  } finally {
    await ownerContext.close();
    await recipientContext.close();
  }
});
