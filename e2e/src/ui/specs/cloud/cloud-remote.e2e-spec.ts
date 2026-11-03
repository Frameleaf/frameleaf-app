import { faker } from '@faker-js/faker';
import { expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { CloudMockState, setupCloudMockApiRoutes } from 'src/ui/mock-network/cloud-network.js';

/**
 * Settings → Frameleaf Cloud → Remote access (FL-165, FL-541) against a mocked server: why it cannot
 * be turned on, the answer with the address, "Check it now" and its details, how devices connect with
 * the monthly allowance, your own domain from its records to ready and the address links start with,
 * and the router detail under Connection details (FL-166, FL-167).
 */
const remotePage = '/user-settings?area=cloud&section=cloud-remote';

const defaults = (): NonNullable<CloudMockState['remote']> => ({
  entitled: true,
  enabled: false,
  mode: 'relay',
  customHostname: null,
  customHostnameStatus: null,
  publicUrlChoice: 'frameleaf',
  tested: false,
});

test.describe.configure({ mode: 'parallel' });
test.describe('Frameleaf Cloud remote access', () => {
  let mock: CloudMockState;

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    mock = { state: 'linked', requests: [], remote: defaults() };
    await setupCloudMockApiRoutes(context, mock);
  });

  test('explains why remote access cannot be turned on', async ({ page }) => {
    // FL-544: unlinked or without the plan, the same gate and the same one button; the sheet sorts out
    // which steps are left.
    mock.state = 'unlinked';
    await page.goto(remotePage);
    await expect(page.getByText('Remote access is part of Frameleaf Cloud').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'Get Frameleaf Cloud' }).first()).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Let people reach this server away from home' })).toHaveCount(0);

    mock.state = 'linked';
    mock.remote = { ...defaults(), entitled: false };
    await page.reload();
    await expect(page.getByText('Remote access is part of Frameleaf Cloud').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'Get Frameleaf Cloud' }).first()).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Let people reach this server away from home' })).toHaveCount(0);
  });

  test('turns remote access on and shows the address', async ({ page }) => {
    await page.goto(remotePage);
    await expect(page.getByRole('heading', { name: 'Remote access is off' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('switch', { name: 'Let people reach this server away from home' }).click();
    await expect(page.getByText('Remote access is on.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Remote access is on and working' })).toBeVisible();
    await expect(page.getByText('https://r.u225vlzhsdlhwh4l.frameleaf.net').first()).toBeVisible();
    expect(mock.requests).toContainEqual(
      expect.objectContaining({ method: 'PUT', path: 'admin/cloud/remote', body: { enabled: true } }),
    );
  });

  test('sets up your own domain, checks it and uses it in links', async ({ page }) => {
    mock.remote = { ...defaults(), enabled: true };
    await page.goto(remotePage);
    await page.getByText('Use your own domain', { exact: true }).click();
    const hostname = page.getByRole('textbox', { name: 'Custom hostname' });
    await hostname.fill('photos.frameleaf.net');
    await expect(page.getByText('Use a domain you own; Frameleaf addresses are already set up.')).toBeVisible();

    await hostname.fill('photos.example.com');
    await expect(page.getByText('_acme-challenge.u225vlzhsdlhwh4l.frameleaf.net')).toBeVisible();
    await page.getByRole('button', { name: 'Check my domain' }).click();
    await expect(page.getByText(/The records are not visible yet/)).toBeVisible();

    await page.getByRole('button', { name: 'Check my domain' }).click();
    await expect(page.getByText('photos.example.com is verified.')).toBeVisible();
    await page.getByRole('radio', { name: /Your own domain/ }).check();
    await expect(page.getByText('https://photos.example.com').first()).toBeVisible();
    expect(mock.requests).toContainEqual(
      expect.objectContaining({ method: 'PUT', path: 'admin/cloud/remote', body: { publicUrl: 'custom' } }),
    );

    await page.getByRole('button', { name: 'Remove domain' }).click();
    await expect(page.getByText('Custom domain removed.')).toBeVisible();
  });

  test('checks it now and lists each check', async ({ page }) => {
    mock.remote = { ...defaults(), enabled: true };
    await page.goto(remotePage);
    await page.getByRole('button', { name: 'Check it now' }).click();
    await expect(page.getByText('Connection test finished.')).toBeVisible();
    await page.getByText('Details of the check').click();
    await expect(page.getByText('This server answered over HTTPS through the direct listener.')).toBeVisible();
  });

  test('chooses how devices connect, with router detail under Connection details', async ({ page }) => {
    mock.remote = { ...defaults(), enabled: true };
    await page.goto(remotePage);
    await expect(page.getByText('everything goes through Frameleaf.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('radio', { name: /Straight to your home when possible/ }).check();
    await page.getByText('Connection details').click();
    await expect(page.getByRole('switch', { name: 'I set up my router myself' })).toBeVisible();
  });

  test('says why nothing goes through Frameleaf, then what went through (FL-166)', async ({ page }) => {
    mock.remote = { ...defaults(), enabled: true, relayConnected: false };
    await page.goto(remotePage);
    await page.getByText('Connection details').click();
    await expect(page.getByText('Last problem: The relay refused the tunnel: unavailable')).toBeVisible({
      timeout: 30_000,
    });

    mock.remote = { ...defaults(), enabled: true, relayConnected: true };
    await page.reload();
    await page.getByText('Connection details').click();
    await expect(page.getByText('Response time 24 ms')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('5 MB in, 50 MB out')).toBeVisible();
    await expect(page.getByText(/^Last problem/)).toHaveCount(0);
  });

  test('shows this month through Frameleaf against the plan’s allowance (FL-166)', async ({ page }) => {
    mock.remote = { ...defaults(), enabled: true, relayConnected: true };
    await page.goto(remotePage);
    await expect(page.getByRole('meter', { name: 'Sent through Frameleaf this month' })).toHaveAttribute(
      'aria-valuenow',
      '80',
      { timeout: 30_000 },
    );
    await expect(page.getByText('of 200 GB')).toBeVisible();
    expect(mock.requests.some(({ method, path }) => method === 'GET' && path === 'admin/cloud/remote/usage')).toBe(
      true,
    );
  });

  test('asks for no allowance before the server is linked (FL-166)', async ({ page }) => {
    mock.state = 'unlinked';
    await page.goto(remotePage);
    await expect(page.getByText('Remote access is part of Frameleaf Cloud').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('meter', { name: 'Sent through Frameleaf this month' })).toHaveCount(0);
    expect(mock.requests.some(({ path }) => path === 'admin/cloud/remote/usage')).toBe(false);
  });

  test('shows the router mapping states (FL-167)', async ({ page }) => {
    mock.remote = { ...defaults(), enabled: true, mode: 'relay-and-direct', mapping: 'upnp', wanVerified: true };
    await page.goto(remotePage);
    await page.getByText('Connection details').click();
    await expect(page.getByText('UPnP · 203.0.113.7')).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText('Reachable from the internet at 203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:2443'),
    ).toBeVisible();

    mock.remote = { ...defaults(), enabled: true, mode: 'relay-and-direct', bridge: true };
    await page.reload();
    await page.getByText('Connection details').click();
    await expect(page.getByText('The router can’t be reached from this container')).toBeVisible({ timeout: 30_000 });

    mock.remote = { ...defaults(), enabled: true, mode: 'relay-and-direct', cgnat: true };
    await page.reload();
    await page.getByText('Connection details').click();
    await expect(page.getByText('Your internet provider shares one public address')).toBeVisible({ timeout: 30_000 });
  });
});
