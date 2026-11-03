import {
  LockedEncryptionMode,
  LoginResponseDto,
  enableLockedEncryption,
  getLockedEncryption,
  lockAssets,
  lockLockedEncryption,
  setUserOnboarding,
  setupPinCode,
  unlockAuthSession,
} from '@frameleaf/sdk';
import { expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { app, asBearerAuth, utils } from 'src/utils.js';
import { test } from 'src/web-test.js';

/**
 * FL-721 (spec §15, Advanced Security) in the browser: after a restart, opening Locked asks for the
 * passphrase at once, and once it is typed the encrypted photos load. Lock now asks again.
 *
 * Restarting needs `FRAMELEAF_E2E_RESTART` (a shell command) on a native server; otherwise the
 * compose container `immich-e2e-server` is restarted.
 */

const run = promisify(execFile);
const pinCode = '357902';
const passphrase = 'amber kettle meadow lantern 3Wq';

const keyLoaded = async (accessToken: string) => {
  const status = await getLockedEncryption({ headers: asBearerAuth(accessToken) });
  return status.keyLoaded;
};

const restartServer = async () => {
  const command = process.env.FRAMELEAF_E2E_RESTART;
  await (command ? run('bash', ['-c', command]) : run('docker', ['restart', 'immich-e2e-server']));
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      const response = await fetch(`${app}/server/ping`);
      if (response.ok) {
        return;
      }
    } catch {
      // restarting
    }
    await sleep(1000);
  }
  throw new Error('The server did not come back after the restart');
};

test.describe('Locked encryption in the browser (FL-721)', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;
  let assetId: string;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    const suffix = randomUUID().slice(0, 8);
    user = await utils.userSetup(admin.accessToken, {
      email: `fl721-web-${suffix}@example.com`,
      name: `Locked ${suffix}`,
      password: 'password',
    });
    const headers = asBearerAuth(user.accessToken);
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers });
    const asset = await utils.createAsset(user.accessToken, { assetData: { filename: `secret-${suffix}.png` } });
    assetId = asset.id;
    await utils.waitForAssetReady(admin.accessToken, assetId, { headers });
    await setupPinCode({ pinCodeSetupDto: { pinCode } }, { headers });
    await unlockAuthSession({ sessionUnlockDto: { pinCode } }, { headers });
    await lockAssets({ bulkIdsDto: { ids: [assetId] } }, { headers });
    await enableLockedEncryption(
      { lockedEncryptionEnableDto: { mode: LockedEncryptionMode.Advanced, pinCode, passphrase } },
      { headers },
    );
    // every Locked item encrypted
    for (let attempt = 0; attempt < 240; attempt++) {
      const status = await getLockedEncryption({ headers });
      if (status.counts.encrypted >= 1) {
        return;
      }
      await sleep(500);
    }
    throw new Error('The Locked item was not encrypted');
  });

  test('after a restart, Locked asks for the passphrase and then shows the photos', async ({ context, page }) => {
    test.setTimeout(240_000);
    const headers = asBearerAuth(user.accessToken);
    await restartServer();
    // the PIN unlock is the session's; the key is gone with the restart
    await unlockAuthSession({ sessionUnlockDto: { pinCode } }, { headers });
    expect(await keyLoaded(user.accessToken)).toBe(false);
    await utils.setAuthCookies(context, user.accessToken);

    await page.goto('/locked');
    const dialog = page.getByRole('dialog', { name: 'Type your passphrase' });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await dialog.getByPlaceholder('Passphrase').fill(passphrase);
    await dialog.getByRole('button', { name: 'Unlock' }).click();

    await expect(dialog).toBeHidden();
    const thumbnail = page.locator(`img[src*="${assetId}"]`).first();
    await expect(thumbnail).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    expect(await keyLoaded(user.accessToken)).toBe(true);
  });

  test('Lock now: opening Locked asks for the passphrase again', async ({ context, page }) => {
    const headers = asBearerAuth(user.accessToken);
    await lockLockedEncryption({ headers });
    await utils.setAuthCookies(context, user.accessToken);

    await page.goto('/locked');
    await expect(page.getByRole('dialog', { name: 'Type your passphrase' })).toBeVisible({ timeout: 60_000 });
  });
});
