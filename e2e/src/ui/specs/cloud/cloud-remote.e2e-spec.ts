import { faker } from '@faker-js/faker';
import { expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { CloudMockState, setupCloudMockApiRoutes } from 'src/ui/mock-network/cloud-network.js';

/**
 * Settings → Frameleaf Cloud → Remote access (FL-165) against a mocked server: why it cannot be turned
 * on, turning it on with the public address, the custom hostname from its records to verified and
 * "Use my domain", the connection test, direct connections, the relay status panel (FL-166) and
 * router mapping states (FL-167).
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
    mock.state = 'unlinked';
    await page.goto(remotePage);
    await expect(page.getByText('Link this server to a Frameleaf account first.').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('switch', { name: 'Allow remote access' })).toBeDisabled();

    mock.state = 'linked';
    mock.remote = { ...defaults(), entitled: false };
    await page.reload();
    await expect(page.getByText('Remote access is included with a Frameleaf Cloud plan.').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'See plans' })).toBeVisible();
  });

  test('turns remote access on and shows the public address', async ({ page }) => {
    await page.goto(remotePage);
    await page.getByRole('switch', { name: 'Allow remote access' }).click();
    await expect(page.getByText('Remote access is on.')).toBeVisible();
    await expect(page.getByText('https://r.u225vlzhsdlhwh4l.frameleaf.net').first()).toBeVisible();
    await expect(page.getByText('This server only; the private key never leaves it')).toBeVisible();
    expect(mock.requests).toContainEqual(
      expect.objectContaining({ method: 'PUT', path: 'admin/cloud/remote', body: { enabled: true } }),
    );
  });

  test('adds a custom hostname, verifies it and publishes it', async ({ page }) => {
    mock.remote = { ...defaults(), enabled: true };
    await page.goto(remotePage);
    // FL-168 put the Public server URL (placeholder https://photos.example.com) on this page too.
    const hostname = page.getByRole('textbox', { name: 'Custom hostname' });
    await hostname.fill('photos.frameleaf.net');
    await expect(page.getByText('Use a domain you own; Frameleaf addresses are already set up.')).toBeVisible();

    await hostname.fill('photos.example.com');
    await expect(page.getByText('_acme-challenge.u225vlzhsdlhwh4l.frameleaf.net')).toBeVisible();
    await page.getByRole('button', { name: 'Check DNS' }).click();
    await expect(page.getByText('Waiting for DNS')).toBeVisible();

    await page.getByRole('button', { name: 'Check DNS' }).click();
    await expect(page.getByText('photos.example.com is verified.')).toBeVisible();
    await page.getByRole('button', { name: 'Use my domain' }).click();
    await expect(page.getByText('https://photos.example.com').first()).toBeVisible();
    expect(mock.requests).toContainEqual(
      expect.objectContaining({ method: 'PUT', path: 'admin/cloud/remote', body: { publicUrl: 'custom' } }),
    );

    await page.getByRole('button', { name: 'Remove domain' }).click();
    await expect(page.getByText('Custom domain removed.')).toBeVisible();
  });

  test('runs the connection test', async ({ page }) => {
    mock.remote = { ...defaults(), enabled: true };
    await page.goto(remotePage);
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByText('Connection test finished.')).toBeVisible();
    await expect(page.getByText('This server answered over HTTPS through the direct listener.')).toBeVisible();
  });

  test('offers port forwarding for direct connections', async ({ page }) => {
    mock.remote = { ...defaults(), enabled: true };
    await page.goto(remotePage);
    await expect(page.getByText('Port forwarding')).toBeHidden();
    await page.getByRole('combobox').selectOption('relay-and-direct');
    await expect(page.getByText('Port forwarding')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'I forward the port myself' })).toBeVisible();
  });

  test('shows the relay status panel (FL-166)', async ({ page }) => {
    mock.remote = { ...defaults(), enabled: true, relayConnected: false };
    await page.goto(remotePage);
    await expect(page.getByText('Last problem: The relay refused the tunnel: unavailable')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Not connected').first()).toBeVisible();

    mock.remote = { ...defaults(), enabled: true, relayConnected: true };
    await page.reload();
    await expect(page.getByText('24 ms')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Connected since')).toBeVisible();
    await expect(page.getByText('5 MiB in, 50 MiB out')).toBeVisible();
    await expect(page.getByText(/^Last problem/)).toHaveCount(0);
  });

  test('shows relay use this month against the plan’s allowance (FL-166)', async ({ page }) => {
    mock.remote = { ...defaults(), enabled: true, relayConnected: true };
    await page.goto(remotePage);
    const meter = page.getByRole('meter', { name: 'Relay use this month' });
    await expect(meter).toHaveAttribute('aria-valuenow', '171798691840', { timeout: 30_000 });
    await expect(page.getByText('160 GiB of 200 GiB')).toBeVisible();
    expect(mock.requests.some(({ method, path }) => method === 'GET' && path === 'admin/cloud/remote/usage')).toBe(
      true,
    );
  });

  test('asks for no relay use before the server is linked (FL-166)', async ({ page }) => {
    mock.state = 'unlinked';
    await page.goto(remotePage);
    await expect(page.getByText('Link this server to a Frameleaf account first.').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('meter', { name: 'Relay use this month' })).toHaveCount(0);
    expect(mock.requests.some(({ path }) => path === 'admin/cloud/remote/usage')).toBe(false);
  });

  test('shows the router mapping states (FL-167)', async ({ page }) => {
    mock.remote = { ...defaults(), enabled: true, mode: 'relay-and-direct', mapping: 'upnp', wanVerified: true };
    await page.goto(remotePage);
    await expect(page.getByText('UPnP', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('203.0.113.7')).toBeVisible();
    await expect(
      page.getByText('Reachable from the internet at 203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:2443'),
    ).toBeVisible();

    mock.remote = { ...defaults(), enabled: true, mode: 'relay-and-direct', bridge: true };
    await page.reload();
    await expect(page.getByText('The router can’t be reached from this container')).toBeVisible({ timeout: 30_000 });

    mock.remote = { ...defaults(), enabled: true, mode: 'relay-and-direct', cgnat: true };
    await page.reload();
    await expect(page.getByText('Your internet provider shares one public address')).toBeVisible({ timeout: 30_000 });
  });
});
