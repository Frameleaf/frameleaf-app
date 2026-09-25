import { LoginResponseDto, ManualJobName, QueueName } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { utils } from 'src/utils.js';

test.describe.configure({ mode: 'serial' });

test.describe.skip('Integrity', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  test('run integrity jobs to update stats', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);

    await utils.createJob(admin.accessToken, {
      name: ManualJobName.IntegrityUntrackedFiles,
    });

    await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

    // FL-71: integrity checks are the Command Center's Maintenance → Integrity checks section.
    await page.goto('/user-settings?area=maintenance&section=integrity');

    // FL-81: each check is the prototype's card (`Maintenance.jsx:449-491`): "Last run … · n findings".
    const count = page.getByRole('article', { name: 'Untracked Files' }).getByText(/Last run .* · \d+ findings?/);
    const findings = async () => {
      const text = await count.textContent();
      return Number(text?.match(/(\d+) findings?/)?.[1]);
    };

    const previousCount = await findings();

    await utils.mkFolder(`/data/upload/${admin.userId}`);
    await utils.putTextFile('untracked', `/data/upload/${admin.userId}/untracked1.png`);

    const checkButton = page.getByRole('button', { name: 'Run all checks' });

    await checkButton.click();
    await expect(checkButton).toBeEnabled();

    await expect.poll(findings).toBe(previousCount + 1);
  });
});
