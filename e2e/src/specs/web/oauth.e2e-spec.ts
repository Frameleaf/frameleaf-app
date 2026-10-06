import { OAuthClient } from '@frameleaf/e2e-auth-server';
import {
  LoginResponseDto,
  createUserAdmin,
  getConfigDefaults,
  login,
  logout,
  setUserOnboarding,
  updateConfig,
} from '@frameleaf/sdk';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

// FL-80: the administrator's own OAuth provider in a real browser, against the e2e provider. The
// server reaches the provider as `e2e-auth-server`; the browser is pointed at the published port.
test.use({ launchOptions: { args: ['--host-resolver-rules=MAP e2e-auth-server 127.0.0.1'] } });

const authServer = { internal: 'http://e2e-auth-server:2286', external: 'http://127.0.0.1:2286' };
const buttonText = 'Sign in with the test provider';
const sub = 'oauth-web';
const password = 'password';

/** The provider's own sign-in and consent screens, from its sign-in page on. */
const providerApprove = async (page: Page) => {
  await page.waitForURL(/e2e-auth-server:2286/);
  await page.locator('input[name="login"]').fill(sub);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  // consent
  await page.locator('button[type="submit"]').click();
};

const providerSignIn = async (page: Page) => {
  await page.getByRole('button', { name: buttonText }).click();
  await providerApprove(page);
};

const accessCookie = async (context: BrowserContext) => {
  const cookies = await context.cookies();
  return cookies.find((cookie) => cookie.name === 'immich_access_token');
};

const providerIssuer = async () => {
  const response = await fetch(`${authServer.external}/.well-known/openid-configuration`);
  const { issuer } = (await response.json()) as { issuer: string };
  return issuer;
};

test.describe('Sign in with the administrator’s OAuth provider (FL-80)', () => {
  let admin: LoginResponseDto;

  test.beforeAll(() => {
    utils.initSdk();
  });

  test.beforeEach(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();

    const options = { headers: asBearerAuth(admin.accessToken) };
    const defaults = await getConfigDefaults(options);
    await updateConfig(
      {
        adminConfigDto: {
          ...defaults,
          oauth: {
            ...defaults.oauth,
            enabled: true,
            autoLaunch: false,
            buttonText,
            clientId: OAuthClient.DEFAULT,
            clientSecret: OAuthClient.DEFAULT,
            issuerUrl: `${authServer.internal}/.well-known/openid-configuration`,
            accountManagementUrl: authServer.internal,
            allowInsecureRequests: true,
          },
        },
      },
      options,
    );

    // an existing, onboarded account the provider's verified email links to
    const email = `${sub}@immich.app`;
    await createUserAdmin({ userAdminCreateDto: { email, password: 'account-password', name: 'OAuth Web' } }, options);
    const session = await login({ loginCredentialDto: { email, password: 'account-password' } });
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(session.accessToken) });
    await logout({ headers: asBearerAuth(session.accessToken) });
  });

  test('finishes a deep-linked sign-in whose callback opens in another tab', async ({ context, page }) => {
    await page.goto('/auth/login?continue=' + encodeURIComponent('/albums'));

    // this tab starts the sign-in but never reaches the provider; another tab of the browser does,
    // and the provider's callback lands there (an email link, a reopened pop-up)
    const authorize = page.waitForRequest(/e2e-auth-server:2286\/auth\?/);
    await page.route(/e2e-auth-server:2286\/auth\?/, (route) => route.abort());
    await page.getByRole('button', { name: buttonText }).click();
    const request = await authorize;

    const other = await context.newPage();
    await other.goto(request.url());
    await providerApprove(other);
    await expect(other).toHaveURL(/\/albums(\?|$)/);
    expect(await accessCookie(context)).toBeDefined();
  });

  test('ignores a continuation to another origin after the provider', async ({ page }) => {
    await page.goto('/auth/login?continue=' + encodeURIComponent('https://evil.example/'));
    const origin = new URL(page.url()).origin;
    await providerSignIn(page);

    await expect(page).toHaveURL(/\/photos(\?|$)/);
    expect(new URL(page.url()).origin).toBe(origin);
  });

  test('shows a provider refusal, stays signed out, and signs in on retry', async ({ context, page }) => {
    await page.goto('/auth/login');
    const authorize = page.waitForRequest(/e2e-auth-server:2286\/auth\?/);
    await page.getByRole('button', { name: buttonText }).click();
    const request = await authorize;
    const state = new URL(request.url()).searchParams.get('state') ?? '';
    expect(state).not.toBe('');
    await page.waitForURL(/e2e-auth-server:2286/);
    const issuer = await providerIssuer();

    // what the provider sends back when the person declines
    await page.goto('/auth/login?' + new URLSearchParams({ error: 'access_denied', state, iss: issuer }).toString());
    await expect(page.getByRole('alert')).toHaveText('The identity provider did not approve the sign-in. Try again.');
    await expect(page).toHaveURL(/\/auth\/login/);
    expect(await accessCookie(context)).toBeUndefined();

    await providerSignIn(page);
    await expect(page).toHaveURL(/\/photos(\?|$)/);
  });

  test('refuses a callback link that was already used', async ({ browser, page }) => {
    const callbackRequest = page.waitForRequest(/\/auth\/login\?.*code=/);
    await page.goto('/auth/login');
    await providerSignIn(page);
    const request = await callbackRequest;
    const callback = request.url();
    await expect(page).toHaveURL(/\/photos(\?|$)/);

    // the same link, replayed from another browser
    const replay = await browser.newContext();
    const other = await replay.newPage();
    await other.goto(callback);
    await expect(other.getByRole('alert')).toBeVisible();
    await expect(other).toHaveURL(/\/auth\/login/);
    expect(await accessCookie(replay)).toBeUndefined();
    await replay.close();
  });
});
