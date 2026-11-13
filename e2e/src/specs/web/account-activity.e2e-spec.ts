import { login, setUserOnboarding } from '@frameleaf/sdk';
import { expect, test } from '@playwright/test';
import { createUserDto } from 'src/fixtures.js';
import { asBearerAuth, utils } from 'src/utils.js';

// FL-824: Account activity (your own) and the household Activity log (administrators), over the
// activity the server records (FL-808).
const activityUrl = '/user-settings?area=privacy&section=account-activity';
const usersUrl = '/user-settings?area=users&section=accounts';

test.describe('Account activity', () => {
  let admin: { accessToken: string; userId: string };
  let member: { accessToken: string; userId: string };

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    // each setup signs the account in, which is the first row of its activity
    admin = await utils.adminSetup();
    member = await utils.userSetup(admin.accessToken, createUserDto.user1);
    // account setup done, so the settings pages open straight away
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(member.accessToken) });
    // one wrong password for the member: a row that says so, on their page and in the household log
    await expect(
      login({ loginCredentialDto: { email: createUserDto.user1.email, password: 'not-the-password' } }),
    ).rejects.toThrow();
  });

  test('a member sees their own sign-ins, filters them, and is told what to do about one that was not them', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, member.accessToken);

    // the row on Your sign-in & privacy opens the page
    await page.goto('/user-settings?area=privacy');
    await page.getByRole('button', { name: 'Open: Account activity' }).click();
    await page.waitForURL(`**${activityUrl}`);
    await expect(page.getByRole('heading', { name: 'Account activity', level: 1 })).toBeVisible();
    await expect(page.getByText('Only you and this server’s administrators can see this list.')).toBeVisible();

    // the wrong password is raised at the top and listed as a row; the sign-in is listed too
    await expect(
      page.getByRole('heading', { name: 'The wrong password was entered once in the last day' }),
    ).toBeVisible();
    const failed = page.locator('li[data-action="sign-in-failed"]');
    await expect(failed).toHaveCount(1);
    await expect(failed.getByText('Didn’t get in')).toBeVisible();
    await expect(page.locator('li[data-action="signed-in"]')).toHaveCount(1);
    // (only this account's rows: the administrator's sign-in is not counted here)

    // the chips filter what is loaded
    await page.getByRole('button', { name: 'Sharing', exact: true }).click();
    await expect(page.getByText('Nothing shared in this list yet')).toBeVisible();
    await page.getByRole('button', { name: 'Show all activity' }).click();
    await page.getByRole('button', { name: 'Security', exact: true }).click();
    await expect(page.getByText('No security changes in this list yet')).toBeVisible();
    await page.getByRole('button', { name: 'Sign-ins', exact: true }).click();
    await expect(failed).toHaveCount(1);

    // "This wasn't me" says what to do and opens the page where it is done
    await failed.getByRole('button', { name: /^This wasn’t me/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Didn’t do this?' })).toBeVisible();
    await expect(dialog.getByText('Change your password.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Change my password' }).click();
    await page.waitForURL('**/user-settings?area=privacy&section=password');
  });

  test('an administrator sees everyone’s activity, and one person’s', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);

    await page.goto(usersUrl);
    await page.getByRole('button', { name: 'Open Activity log' }).click();
    await page.waitForURL(`**${usersUrl}&show=activity`);
    await expect(page.getByRole('heading', { name: 'Activity log', level: 1 })).toBeVisible();

    // both accounts' sign-ins, each naming who it is about
    const signedIn = page.locator('li[data-action="signed-in"]');
    await expect(signedIn).toHaveCount(2);
    await expect(signedIn.filter({ hasText: `${createUserDto.user1.name} signed in` })).toHaveCount(1);
    const failed = page.locator('li[data-action="sign-in-failed"]');
    await expect(failed).toContainText(`Wrong password entered for ${createUserDto.user1.name}`);
    // nobody else's row offers "This wasn't me"
    await expect(page.getByRole('button', { name: /^This wasn’t me/ })).toHaveCount(0);

    // "Whose" narrows the list to one person
    await page.getByRole('combobox', { name: 'Whose activity' }).selectOption({ label: createUserDto.user1.name });
    await page.waitForURL(`**${usersUrl}&show=activity&who=${member.userId}`);
    await expect(signedIn).toHaveCount(1);

    // a sign-in that did not work opens that person's page, which links back to their activity
    await failed.getByRole('button', { name: `Open ${createUserDto.user1.name}’s page` }).click();
    await page.waitForURL(`**${usersUrl}&user=${member.userId}`);
    await page.getByRole('button', { name: `All of ${createUserDto.user1.name}’s activity` }).click();
    await page.waitForURL(`**${usersUrl}&show=activity&who=${member.userId}`);
    await expect(page.getByRole('heading', { name: 'Activity log', level: 1 })).toBeVisible();
  });
});
