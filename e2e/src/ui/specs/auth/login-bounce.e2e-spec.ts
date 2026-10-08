import { faker } from '@faker-js/faker';
import { expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-167: Sign in with Frameleaf from a home address (the LAN name the edge worker published) goes
 * through the public address (the relay name or the verified custom domain) and comes back with a
 * single-use code in the fragment, which signs in here.
 */
const RELAY = 'https://r.u225vlzhsdlhwh4l.frameleaf.net';

const publicConfig = (frameleaf: Record<string, unknown>) => ({
  server: { loginPageMessage: '' },
  passwordLogin: { enabled: true },
  oauth: { enabled: false, autoLaunch: false, buttonText: 'Login with OAuth' },
  frameleafCloud: { signIn: { buttonText: 'Sign in with Frameleaf', showOnLocalLogin: true } },
  frameleaf: {
    signInAvailable: true,
    signInRequired: false,
    via: 'lan',
    relayHost: null,
    localUrl: null,
    sameNetwork: false,
    signInOrigin: RELAY,
    ...frameleaf,
  },
});

test.describe('Sign in with Frameleaf from a home address', () => {
  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    // signed out
    await context.route('**/api/users/me', (route) =>
      route.fulfill({ status: 401, json: { message: 'Unauthorized' } }),
    );
    await context.route('**/api/public/config', (route) => route.fulfill({ json: publicConfig({}) }));
  });

  test('leaves for the public address with the home address to come back to', async ({ context, page }) => {
    const bounced = new Promise<string>((resolve) => {
      void context.route(`${RELAY}/**`, (route) => {
        resolve(route.request().url());
        return route.fulfill({ contentType: 'text/html', body: '<p>public address</p>' });
      });
    });
    await page.goto('/auth/login');
    const home = new URL(page.url()).origin;
    await page.getByRole('button', { name: 'Sign in with Frameleaf' }).click();
    const url = new URL(await bounced);
    expect(url.origin).toBe(RELAY);
    expect(url.pathname).toBe('/auth/login');
    expect(url.searchParams.get('frameleafReturn')).toBe(home);
  });

  test('signs in with the code it was handed back, only in the tab that asked', async ({ context, page }) => {
    let redeemed: unknown = null;
    await context.route('**/api/oauth/frameleaf/handoff/redeem', (route) => {
      redeemed = route.request().postDataJSON();
      return route.fulfill({ status: 400, json: { message: 'This sign-in code is not valid any more' } });
    });
    const nonce = 'n'.repeat(32);
    // someone else's code, without this tab's nonce, is never used
    await page.goto(`/auth/login#frameleafHandoff=someone-elses&frameleafNonce=${nonce}`);
    await expect(page.getByRole('button', { name: 'Sign in with Frameleaf' })).toBeVisible({ timeout: 30_000 });
    expect(redeemed).toBeNull();

    await page.evaluate((value) => sessionStorage.setItem('frameleaf.auth.handoffNonce', value), nonce);
    // a fresh load (a fragment-only change would not reload the page)
    await page.goto('about:blank');
    await page.goto(`/auth/login#frameleafHandoff=one-time-code&frameleafNonce=${nonce}`);
    await expect(page.getByText('This sign-in code is not valid any more')).toBeVisible({ timeout: 30_000 });
    expect(redeemed).toEqual({ code: 'one-time-code', rememberMe: true });
    // the code is taken out of the address at once
    expect(page.url()).not.toContain('one-time-code');
  });
});
