import { LoginResponseDto, QueueName, updateQueue } from '@frameleaf/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

/**
 * FL-1459: Activity's In progress by what came in (prototype `ActivityWorkV3.jsx`). An upload from a phone is its own
 * group, named after the phone and counted, and the switch shows the same work by feature.
 */
test.describe('Activity, by what came in (FL-1459)', () => {
  let admin: LoginResponseDto;
  const holdMetadata = (isPaused: boolean) =>
    updateQueue(
      { name: QueueName.MetadataExtraction, queueUpdateDto: { isPaused } },
      { headers: asBearerAuth(admin.accessToken) },
    );

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    // A test login is no phone: make it one, as the app's sign-in would.
    const db = await utils.connectDatabase();
    await db.query(`UPDATE public.session SET "deviceOS" = 'iOS', "deviceType" = 'iPhone 15' WHERE "userId" = $1`, [
      admin.userId,
    ]);
    // Held at its first step, so the upload is still coming in when the page opens.
    await holdMetadata(true);
    await utils.createAsset(admin.accessToken);
    await utils.createAsset(admin.accessToken);
  });

  test.afterAll(async () => {
    await holdMetadata(false);
  });

  test('shows a phone upload as its own group with its count, and switches to By feature', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/activity');

    const progress = page.getByRole('region', { name: 'In progress' });
    await expect(progress.getByText('2 photos from iPhone 15')).toBeVisible();
    await expect(progress.getByRole('button', { name: 'By what came in' })).toHaveAttribute('aria-pressed', 'true');
    await expect(progress.getByRole('list', { name: '2 photos from iPhone 15, step by step' })).toBeVisible();

    await progress.getByRole('button', { name: 'By feature' }).click();
    await expect(progress.getByText('Ready to browse')).toBeVisible();
    await expect(progress.getByText('2 photos from iPhone 15')).toHaveCount(0);

    // The choice is kept for the next visit.
    await page.reload();
    await expect(progress.getByRole('button', { name: 'By feature' })).toHaveAttribute('aria-pressed', 'true');
  });
});
