import { LoginResponseDto, createUserAdmin, getMyUser, login, logout, setUserOnboarding } from '@immich/sdk';
import { expect, test, type Page } from '@playwright/test';
import { createUserDto } from 'src/fixtures.js';
import { asBearerAuth, utils } from 'src/utils.js';

test.describe('Registration', () => {
  test.beforeAll(() => {
    utils.initSdk();
  });

  test.beforeEach(async () => {
    await utils.resetDatabase();
  });

  test('admin registration', async ({ page }) => {
    // welcome
    await page.goto('/');
    await page.getByRole('link', { name: 'Getting Started' }).click();

    // register (FL-80 prototype screen; the strength meter is advisory, the server decides)
    await expect(page).toHaveTitle(/Admin Registration/);
    await expect(page.getByRole('heading', { name: 'Create the admin account' })).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill('Immich Admin');
    await page.getByLabel('Email', { exact: true }).fill('admin@immich.app');
    await page.getByLabel('Password', { exact: true }).fill('password');
    await page.getByLabel('Confirm password', { exact: true }).fill('password');
    await page.getByRole('button', { name: 'Create account' }).click();

    // login
    await expect(page).toHaveTitle(/Login/);
    await page.goto('/auth/login?autoLaunch=0');
    await page.getByLabel('Email', { exact: true }).fill('admin@immich.app');
    await page.getByLabel('Password', { exact: true }).fill('password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // onboarding
    // FL-80 ON-1: the prototype's onboarding — a step rail, Next through every step, then the
    // summary's "Open Frameleaf". The server's first administrator sees all nine steps.
    await expect(page).toHaveURL('/auth/onboarding');
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
    for (const title of [
      'Choose your language',
      'Pick a theme',
      'Server Privacy',
      'Your privacy',
      'Storage template',
      'Back up your phone',
      'Get the mobile app',
      "You're all set",
    ]) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
    }
    // The rail's compact progress line is visual only (aria-hidden); the panel announces the step.
    await expect(page.getByRole('paragraph').filter({ hasText: 'Step 9 of 9' })).toBeAttached();
    await page.getByRole('button', { name: 'Open Frameleaf' }).click();

    // success
    await expect(page).toHaveURL(/\/photos(\?|$)/);
  });

  test('user registration', async ({ context, page }) => {
    const admin = await utils.adminSetup();
    await utils.setAuthCookies(context, admin.accessToken);

    // create user
    // FL-71: the old address opens the Command Center's Users manager.
    await page.goto('/admin/user-management');
    await page.waitForURL('**/user-settings?area=users&section=accounts');
    await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create account' });
    await dialog.getByLabel('Email').fill('user@immich.cloud');
    await dialog.getByLabel('Initial password').fill('password');
    await dialog.getByLabel('Confirm password').fill('password');
    await dialog.getByLabel('Name').fill('Immich User');
    await dialog.getByRole('button', { name: 'Create account' }).click();
    await expect(dialog).toHaveCount(0);

    // logout
    await context.clearCookies();

    // login
    await page.goto('/auth/login?autoLaunch=0');
    await page.getByLabel('Email', { exact: true }).fill('user@immich.cloud');
    await page.getByLabel('Password', { exact: true }).fill('password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // change password (FL-80 prototype screen)
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await expect(page).toHaveURL('/auth/change-password');
    await page.getByLabel('New password', { exact: true }).fill('new-password');
    await page.getByLabel('Confirm new password', { exact: true }).fill('new-password');
    await page.getByRole('button', { name: 'Save and continue' }).click();

    // login with new password
    await expect(page).toHaveURL('/auth/login?autoLaunch=0');
    await page.getByLabel('Email', { exact: true }).fill('user@immich.cloud');
    await page.getByLabel('Password', { exact: true }).fill('new-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // onboarding
    // FL-80 ON-1: an account on an onboarded server skips the server steps.
    await expect(page).toHaveURL('/auth/onboarding');
    for (const title of [
      'Choose your language',
      'Pick a theme',
      'Your privacy',
      'Back up your phone',
      'Get the mobile app',
      "You're all set",
    ]) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Storage' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open Frameleaf' }).click();

    // success
    await expect(page).toHaveURL(/\/photos/);
  });
});

const signIn = async (page: Page, email: string, password: string) => {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
};

// FL-80: the sign-in lifecycle around the Frameleaf auth screens (web/src/routes/auth/**).
test.describe('Sign-in lifecycle', () => {
  let admin: LoginResponseDto;

  const createUser = async (key: string, { shouldChangePassword = false, onboarded = true } = {}) => {
    const dto = createUserDto.create(key);
    await createUserAdmin(
      { userAdminCreateDto: { ...dto, shouldChangePassword } },
      { headers: asBearerAuth(admin.accessToken) },
    );
    if (onboarded) {
      const session = await login({ loginCredentialDto: { email: dto.email, password: dto.password } });
      await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(session.accessToken) });
      await logout({ headers: asBearerAuth(session.accessToken) });
    }
    return dto;
  };

  test.beforeAll(() => {
    utils.initSdk();
  });

  test.beforeEach(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  test('signs in with the keyboard only', async ({ page }) => {
    // FL-80: keyboard-only sign-in — Tab reaches Email, Tab moves to Password, Enter submits.
    const user = await createUser('keyboard');
    await page.goto('/auth/login?autoLaunch=0');
    const email = page.getByLabel('Email', { exact: true });
    const password = page.getByLabel('Password', { exact: true });
    await expect(email).toBeVisible();

    // Start from the top of the document so the test proves Tab order, not the autofocus.
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        active.blur();
      }
    });
    for (let presses = 0; presses < 20; presses++) {
      await page.keyboard.press('Tab');
      if (await email.evaluate((element) => element === document.activeElement)) {
        break;
      }
    }
    await expect(email).toBeFocused();
    await page.keyboard.type(user.email);
    await page.keyboard.press('Tab');
    await expect(password).toBeFocused();
    await page.keyboard.type(user.password);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/photos(\?|$)/);
  });

  test('shows the error for a wrong password and signs in on retry', async ({ page }) => {
    // FL-80: a failed sign-in announces the server's message, marks the fields invalid and clears the
    // password; retrying with the right password continues to the library.
    const user = await createUser('retry');
    await page.goto('/auth/login?autoLaunch=0');
    await signIn(page, user.email, 'not-the-password');

    await expect(page.getByRole('alert')).toHaveText('Incorrect email or password');
    await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(page).toHaveURL(/\/auth\/login/);

    await page.getByLabel('Password', { exact: true }).fill(user.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/photos(\?|$)/);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('ignores a continuation to another origin', async ({ page }) => {
    // FL-80: `continue` only ever returns to this server; a foreign address falls back to the library.
    const user = await createUser('continue');
    await page.goto('/auth/login?autoLaunch=0&continue=' + encodeURIComponent('https://evil.example/'));
    const origin = new URL(page.url()).origin;
    await signIn(page, user.email, user.password);

    await expect(page).toHaveURL(/\/photos(\?|$)/);
    expect(new URL(page.url()).origin).toBe(origin);
    expect(new URL(page.url()).hostname).not.toBe('evil.example');
  });

  test('returns to sign-in when the session has been revoked', async ({ context, page }) => {
    // FL-80: an expired or revoked session sends the next navigation back to sign-in.
    const user = await createUser('expired');
    const session = await login({ loginCredentialDto: { email: user.email, password: user.password } });
    await utils.setAuthCookies(context, session.accessToken);
    await page.goto('/photos');
    await expect(page).toHaveURL(/\/photos(\?|$)/);

    await logout({ headers: asBearerAuth(session.accessToken) });
    await expect(getMyUser({ headers: asBearerAuth(session.accessToken) })).rejects.toMatchObject({ status: 401 });

    await page.goto('/photos');
    await expect(page).toHaveURL(/\/auth\/login/);
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  });

  test('forces a password change before continuing', async ({ page }) => {
    // FL-80: an account created with "change password on next sign-in" lands on the change-password
    // screen; saving the new password signs out, and the new password then signs in.
    const user = await createUser('forced', { shouldChangePassword: true, onboarded: false });
    await page.goto('/auth/login?autoLaunch=0');
    await signIn(page, user.email, user.password);

    await expect(page).toHaveURL('/auth/change-password');
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await expect(page.getByLabel('Account', { exact: true })).toHaveValue(user.email);
    await expect(page.getByRole('button', { name: 'Save and continue' })).toBeDisabled();
    await page.getByLabel('New password', { exact: true }).fill('a-new-password');
    await page.getByLabel('Confirm new password', { exact: true }).fill('a-new-password');
    await page.getByRole('button', { name: 'Save and continue' }).click();

    await expect(page).toHaveURL(/\/auth\/login/);
    await signIn(page, user.email, 'a-new-password');
    // Not onboarded yet, so the account continues into onboarding rather than the password screen.
    await expect(page).toHaveURL('/auth/onboarding');

    const session = await login({ loginCredentialDto: { email: user.email, password: 'a-new-password' } });
    expect(session.shouldChangePassword).toBe(false);
  });

  test('moves focus to each onboarding step and advances with Alt+Arrow keys', async ({ context, page }) => {
    // FL-80 ON-1/O-5: each step's heading takes focus; Alt+ArrowRight / Alt+ArrowLeft and Next move
    // between steps, and Alt+ArrowRight on the summary finishes onboarding.
    const user = await createUser('onboarding', { onboarded: false });
    const session = await login({ loginCredentialDto: { email: user.email, password: user.password } });
    await utils.setAuthCookies(context, session.accessToken);
    await page.goto('/auth/onboarding');

    const heading = (name: string) => page.getByRole('heading', { name, level: 1 });
    await expect(heading('Welcome')).toBeFocused();

    await page.keyboard.press('Alt+ArrowRight');
    await expect(heading('Choose your language')).toBeFocused();

    await page.keyboard.press('Alt+ArrowLeft');
    await expect(heading('Welcome')).toBeFocused();

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(heading('Choose your language')).toBeFocused();

    for (const title of [
      'Pick a theme',
      'Your privacy',
      'Back up your phone',
      'Get the mobile app',
      "You're all set",
    ]) {
      await page.keyboard.press('Alt+ArrowRight');
      await expect(heading(title)).toBeFocused();
    }

    await page.keyboard.press('Alt+ArrowRight');
    await expect(page).toHaveURL(/\/photos(\?|$)/);
  });

  test('clears private browser state on sign out', async ({ context, page }) => {
    // FL-80: signing out through the account menu removes the account's Frameleaf browser state.
    const user = await createUser('logout');
    const session = await login({ loginCredentialDto: { email: user.email, password: user.password } });
    await utils.setAuthCookies(context, session.accessToken);
    await page.goto('/photos');
    await expect(page).toHaveURL(/\/photos(\?|$)/);

    await page.evaluate(() => {
      localStorage.setItem('frameleaf:job-manager-history:v1', '[]');
      sessionStorage.setItem('frameleaf:test-private', '1');
    });

    await page.getByRole('button', { name: `Account menu for ${user.name}` }).click();
    await page.getByRole('menuitem', { name: 'Sign Out' }).click();
    await expect(page).toHaveURL(/\/auth\/login/);

    const remaining = await page.evaluate(() => ({
      local: localStorage.getItem('frameleaf:job-manager-history:v1'),
      session: sessionStorage.getItem('frameleaf:test-private'),
    }));
    expect(remaining).toEqual({ local: null, session: null });
  });
});
