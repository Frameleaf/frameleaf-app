import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { setupCloudMockApiRoutes } from 'src/ui/mock-network/cloud-network.js';
import {
  MAIL_PROVIDER_PAGE,
  mailMockState,
  setupMailMockApiRoutes,
  type MailMockState,
} from 'src/ui/mock-network/mail-network.js';

/**
 * Notifications › Email delivery: sending from a Gmail or Microsoft account by signing in (FL-379).
 * Controlled responses qualify what the page shows for each answer of the server and what it asks
 * the server to do; no real Google, Microsoft or Frameleaf Cloud is involved, so a real sign-in and
 * a delivered email are not claimed here.
 */
const emailDelivery = '/user-settings?area=notifications&section=notifications';

test.use({ serviceWorkers: 'block' });
test.setTimeout(60_000);
test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort(),
  );
});

const open = async (context: BrowserContext, page: Page, mock: MailMockState) => {
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: {} }));
  await setupBaseMockApiRoutes(context, '11111111-1111-4111-8111-111111111111');
  await setupCloudMockApiRoutes(context, {
    state: mock.unavailableReason === 'not-linked' ? 'unlinked' : 'linked',
    requests: [],
  });
  await setupMailMockApiRoutes(context, mock);
  await page.goto(emailDelivery);
  await expect(page.getByRole('heading', { name: 'Which email should Frameleaf send from?' })).toBeVisible({
    timeout: 30_000,
  });
};
const providers = (page: Page) => page.getByRole('group', { name: 'Which email should Frameleaf send from?' });
const status = (page: Page) => page.getByRole('region', { name: 'Email status' });

test('signs in with Google in a new tab, then shows the account, tests it and disconnects', async ({
  context,
  page,
}) => {
  const mock = mailMockState({ pendingAnswers: 1 });
  await open(context, page, mock);
  await expect(status(page).getByRole('heading', { name: 'Email is not set up' })).toBeVisible();
  await expect(providers(page).getByRole('button', { name: /^Microsoft/ })).toContainText(
    'Outlook.com, Hotmail and Microsoft 365',
  );

  await providers(page)
    .getByRole('button', { name: /^Gmail/ })
    .click();
  await expect(page.getByText(/Frameleaf can send and nothing else: it cannot read your mail\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use an app password instead' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send a test email' })).toHaveCount(0);

  const [providerPage] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('button', { name: 'Sign in with Google' }).click(),
  ]);
  await providerPage.waitForURL(`**${MAIL_PROVIDER_PAGE}?service=gmail`);
  // the provider's page gets no handle on the settings page
  expect(await providerPage.evaluate(() => window.opener)).toBeNull();
  expect(mock.requests.find(({ path }) => path === 'mail-connection/start')?.body).toEqual({ provider: 'gmail' });
  await expect(page.getByText('Waiting for you on the Google page')).toBeVisible();
  await providerPage.close();

  await expect(page.getByText('Signed in with Google. Frameleaf now sends from rivera.family@gmail.com.')).toBeVisible({
    timeout: 15_000,
  });
  await expect(status(page).getByRole('heading', { name: 'Email is set up' })).toBeVisible();
  await expect(status(page)).toContainText('Frameleaf sends from rivera.family@gmail.com.');
  const account = page.locator('.kit-row').filter({ hasText: 'Signed in as' });
  await expect(account).toContainText('rivera.family@gmail.com');
  await expect(page.getByRole('button', { name: 'Use an app password instead' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Mail server' })).toHaveCount(0);

  await page.getByText('Advanced', { exact: true }).click();
  await expect(page.getByText('Through Google’s own service')).toBeVisible();
  await expect(page.getByRole('switch', { name: /security certificate/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Send a test email' }).click();
  await expect(page.getByText(/^Sent to admin@example\.com at /)).toBeVisible();
  const sent = mock.requests.find(({ path }) => path === 'test-email')?.body as {
    transport: { type: string; password: string };
  };
  expect(sent.transport).toMatchObject({ type: 'gmail', password: '' });

  await account.getByRole('button', { name: 'Disconnect…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Disconnect rivera.family@gmail.com?' });
  await expect(dialog).toContainText('Nothing is sent by email until an account is set up again.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(mock.requests.some(({ method }) => method === 'DELETE')).toBe(false);

  await account.getByRole('button', { name: 'Disconnect…' }).click();
  await page
    .getByRole('dialog', { name: 'Disconnect rivera.family@gmail.com?' })
    .getByRole('button', { name: 'Disconnect', exact: true })
    .click();
  await expect(
    page.getByText('Disconnected from Google. Nothing is sent by email until an account is set up again.'),
  ).toBeVisible();
  await expect(status(page).getByRole('heading', { name: 'Email is not set up' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
});

test('says email stopped and offers to sign in again when the provider asks for it', async ({ context, page }) => {
  const mock = mailMockState({
    transport: 'gmail',
    enabled: true,
    connection: {
      provider: 'gmail',
      email: 'rivera.family@gmail.com',
      status: 'needs-sign-in',
      connectedAt: '2026-10-01T10:00:00.000Z',
      needsSignInSince: '2026-10-10T18:02:00.000Z',
    },
  });
  await open(context, page, mock);

  await expect(status(page).getByRole('heading', { name: 'Email stopped working' })).toBeVisible();
  await expect(status(page)).toContainText('Google is asking you to sign in again.');
  const notice = page.getByRole('status').filter({ hasText: 'Sign in with Google again' });
  await expect(notice).toContainText('the account’s password changes or Frameleaf’s access is removed');
  await expect(notice).toContainText('Emails since then were not sent; they appear in the app only.');
  await expect(page.getByText('Signed in as')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send a test email' })).toHaveCount(0);

  const [providerPage] = await Promise.all([
    context.waitForEvent('page'),
    notice.getByRole('button', { name: 'Sign in again' }).click(),
  ]);
  await providerPage.close();
  await expect(page.getByText('Signed in as')).toBeVisible({ timeout: 15_000 });
  await expect(status(page).getByRole('heading', { name: 'Email is set up' })).toBeVisible();
});

test('a server that is not linked says why and where to link, and keeps the app password route', async ({
  context,
  page,
}) => {
  const mock = mailMockState({ available: false, unavailableReason: 'not-linked', providers: [] });
  await open(context, page, mock);

  await providers(page)
    .getByRole('button', { name: /^Gmail/ })
    .click();
  await expect(page.getByText('Signing in with Google needs a Frameleaf account')).toBeVisible();
  await expect(page.getByText(/The account is free and nothing is paid\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Use an app password instead' }).click();
  await expect(page.getByRole('textbox', { name: 'Email address' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with Google instead' }).click();

  await providers(page)
    .getByRole('button', { name: /^Microsoft/ })
    .click();
  await expect(page.getByText('Signing in with Microsoft needs a Frameleaf account')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use an app password instead' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Link this server' }).click();
  await expect(page).toHaveURL(/area=cloud/);
  expect(mock.requests.some(({ path }) => path === 'mail-connection/start')).toBe(false);
});

test('a provider Frameleaf Cloud has not configured is not offered for sign-in', async ({ context, page }) => {
  await open(context, page, mailMockState({ providers: ['gmail'] }));
  await expect(providers(page).getByRole('button', { name: /^Gmail/ })).toBeVisible();
  await providers(page)
    .getByRole('button', { name: /^Gmail/ })
    .click();
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  await expect(providers(page).getByRole('button', { name: /^Microsoft/ })).toHaveCount(0);
});

test('Microsoft signs in only, and disconnecting says where to remove Frameleaf', async ({ context, page }) => {
  const mock = mailMockState();
  await open(context, page, mock);
  await providers(page)
    .getByRole('button', { name: /^Microsoft/ })
    .click();
  await expect(page.getByRole('button', { name: 'Use an app password instead' })).toHaveCount(0);

  const [providerPage] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('button', { name: 'Sign in with Microsoft' }).click(),
  ]);
  await providerPage.close();
  const account = page.locator('.kit-row').filter({ hasText: 'Signed in as' });
  await expect(account).toContainText('rivera.family@outlook.com', { timeout: 15_000 });

  await account.getByRole('button', { name: 'Disconnect…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open Microsoft’s app permissions' })).toHaveAttribute(
    'href',
    'https://account.live.com/consent/Manage',
  );
});
