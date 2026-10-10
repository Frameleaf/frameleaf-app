import {
  AssetResponseDto,
  ICloudConnectionResponseDto,
  ICloudControlAction,
  LoginResponseDto,
  MediaOperationStatus,
  controlICloudConnection,
  getAuthStatus,
  getICloudInventory,
  listICloudConnections,
  setUserOnboarding,
  setupPinCode,
  unlockAuthSession,
} from '@frameleaf/sdk';
import { Page, expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { asBearerAuth, utils } from 'src/utils.js';

/**
 * FL-144: FL-68 iCloud Photos sync in the browser, against the real server and a TEST-ONLY fake bridge
 * (src/fixtures/icloud-bridge-fixture.mjs, docker-compose.icloud-bridge-fixture.yml) that speaks
 * icloud-bridge/api.md protocol v1 over HTTPS. Every sign-in, save, lock and run control goes through
 * the page; the API and the fake's own counters are only read, to check what the page says.
 *
 * Run with `pnpm test:web:icloud` on a stack started with the iCloud bridge override.
 */

// The feature requires HTTPS in front of the web app: this is the header that reverse proxy adds. The
// override trusts it from the Docker network only.
test.use({ extraHTTPHeaders: { 'X-Forwarded-Proto': 'https' } });

const CONTROL = `http://${process.env.PLAYWRIGHT_HOST ?? '127.0.0.1'}:9444/__fixture`;
const PIN = '482916';
const RUN_TIMEOUT = 90_000;

type FixtureAccount = {
  logins: number;
  wrongCodes: number;
  inventoryPages: number;
  downloadsServed: number;
  downloadsWaiting: number;
  served: Record<string, number>;
};
type FixtureItem = { name: string; hidden: boolean; size: number; sha1: string; sha256: string };
type FixtureState = { accounts: Record<string, FixtureAccount>; libraries: Record<string, FixtureItem[]> };

/** The fake bridge's test-only control: counters, and holding/releasing downloads mid-run. */
const fixture = {
  state: async (): Promise<FixtureState> => {
    const response = await fetch(`${CONTROL}/state`);
    return (await response.json()) as FixtureState;
  },
  account: async (appleId: string): Promise<FixtureAccount> => {
    const { accounts } = await fixture.state();
    return accounts[appleId];
  },
  /** The items of an Apple account the fake serves: names and digests of their exact bytes. */
  library: async (appleId: string): Promise<FixtureItem[]> => {
    const { libraries } = await fixture.state();
    return libraries[appleId];
  },
  post: async (path: string, body: unknown = {}) => {
    const response = await fetch(`${CONTROL}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.ok, `fixture ${path}`).toBe(true);
  },
  hold: (appleId: string, allow: number) => fixture.post('hold', { appleId, allow }),
  release: (appleId: string) => fixture.post('release', { appleId }),
};

/** The deterministic Apple accounts of the fake bridge (ACCOUNTS in the fixture). */
const ACCOUNTS = {
  alice: { appleId: 'alice@icloud.test', password: 'alice-test-only', code: '246810' },
  bob: { appleId: 'bob@icloud.test', password: 'bob-test-only', code: '135791' },
  carol: { appleId: 'carol@icloud.test', password: 'carol-test-only', code: '314159' },
  dana: { appleId: 'dana@icloud.test', password: 'dana-test-only', code: '271828' },
  erin: { appleId: 'erin@icloud.test', password: 'erin-test-only', code: '161803' },
  frank: { appleId: 'frank@icloud.test', password: 'frank-test-only', code: '141421' },
} as const;
type Account = (typeof ACCOUNTS)[keyof typeof ACCOUNTS];

const byName = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name);
const sorted = (values: string[]) => values.toSorted((left, right) => left.localeCompare(right));

const onlyConnection = async (user: LoginResponseDto): Promise<ICloudConnectionResponseDto> => {
  const { connections } = await listICloudConnections({ headers: asBearerAuth(user.accessToken) });
  expect(connections).toHaveLength(1);
  return connections[0];
};
const connectionState = async (user: LoginResponseDto) => {
  const { state } = await onlyConnection(user);
  return state;
};
const runOf = async (user: LoginResponseDto) => {
  const { run } = await onlyConnection(user);
  return run;
};
const isElevated = async (user: LoginResponseDto) => {
  const status = await getAuthStatus({ headers: asBearerAuth(user.accessToken) });
  return status.isElevated;
};
const downloadsWaiting = async (account: Account) => {
  const { downloadsWaiting } = await fixture.account(account.appleId);
  return downloadsWaiting;
};

/** Every asset the user's current session can see (a locked session does not see Locked items). */
const assetsOf = async (user: LoginResponseDto): Promise<AssetResponseDto[]> => {
  const { assets } = await utils.searchAssets(user.accessToken, { size: 1000 });
  return assets.items;
};

/** The assets are exactly these iCloud items, byte for byte, each exactly once. */
const expectExactly = (assets: AssetResponseDto[], items: FixtureItem[]) => {
  expect(new Set(assets.map(({ checksum }) => checksum)).size).toBe(assets.length);
  expect(new Set(assets.map(({ originalFileName }) => originalFileName)).size).toBe(assets.length);
  expect(
    assets.map(({ originalFileName, checksum }) => ({ name: originalFileName, checksum })).toSorted(byName),
  ).toEqual(items.map(({ name, sha256 }) => ({ name, checksum: sha256 })).toSorted(byName));
};

const newUser = async (admin: LoginResponseDto, name: string) => {
  const suffix = randomUUID().slice(0, 8);
  const user = await utils.userSetup(admin.accessToken, {
    email: `${name}-${suffix}@example.com`,
    name: `${name} ${suffix}`,
    password: 'password',
  });
  await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(user.accessToken) });
  return user;
};

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

const openICloud = async (page: Page) => {
  // The bookmarked utility URL lands on Command Center → Utilities → iCloud Photos.
  await page.goto('/utilities/icloud-sync');
  await page.waitForURL((url) => url.searchParams.get('section') === 'icloud');
};

const dialog = (page: Page) => page.getByRole('dialog', { name: 'iCloud connection' });
const badge = (page: Page) => page.locator('.ic-connection .ic-badge');
const runPanel = (page: Page) => page.getByRole('region', { name: 'Sync progress' });
const results = (page: Page) => page.getByRole('region', { name: 'Reconciliation' });
const notice = (page: Page) => page.locator('.ic-message[role="status"]');
const thumbnails = (page: Page) => page.locator('[data-asset-id]');
/** A run control in the page toolbar (not the dialog's own buttons). */
const control = (page: Page, name: string) => page.locator('.ic-toolbar').getByRole('button', { name, exact: true });

/** Add the user's first connection and open its sign-in dialog. */
const addConnection = async (page: Page) => {
  await expect(page.getByRole('heading', { name: 'Connect an iCloud library' })).toBeVisible();
  await page.getByRole('button', { name: 'Add connection' }).click();
  await expect(notice(page)).toContainText('Connection added.');
  await page.getByRole('button', { name: 'Connect account' }).click();
  await expect(dialog(page)).toBeVisible();
};

const signIn = async (page: Page, account: Account) => {
  const form = dialog(page);
  await form.getByLabel('Apple account email').fill(account.appleId);
  await form.getByLabel('Password').fill(account.password);
  await form.getByRole('button', { name: 'Connect account' }).click();
  // Every fixture account has two-factor authentication: the server asks for the code next.
  await expect(form.getByLabel('Six-digit verification code')).toBeVisible();
  await expect(form).toContainText('Awaiting verification');
};

const enterCode = async (page: Page, code: string) => {
  const form = dialog(page);
  await form.getByLabel('Six-digit verification code').fill(code);
  await form.getByRole('button', { name: 'Verify connection' }).click();
};

/** Sign in with the right password and code; the server queues the first sync. */
const connect = async (page: Page, account: Account) => {
  await addConnection(page);
  await signIn(page, account);
  await enterCode(page, account.code);
  await expect(dialog(page)).toBeHidden();
  await expect(notice(page)).toContainText('Account connected. The first sync has started.');
};

test.describe('iCloud Photos sync with a fake bridge (FL-68, FL-144)', () => {
  test.skip(process.env.FL144_ICLOUD_BRIDGE !== 'true', 'Needs docker-compose.icloud-bridge-fixture.yml');
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    await fixture.post('reset');
  });

  test('a wrong verification code asks to sign in again, and the retry connects', async ({ context, page }) => {
    const user = await newUser(admin, 'twofactor');
    const items = await fixture.library(ACCOUNTS.carol.appleId);
    await utils.setAuthCookies(context, user.accessToken);
    await openICloud(page);

    await addConnection(page);
    await signIn(page, ACCOUNTS.carol);
    await expect.poll(() => connectionState(user)).toBe('awaiting-2fa');

    // A wrong code: Apple rejects it and the bridge answers that the account must sign in again.
    await enterCode(page, '000000');
    await expect(dialog(page)).toContainText('Sign in again');
    await expect(dialog(page).getByLabel('Apple account email')).toBeVisible();
    await expect(dialog(page).getByLabel('Six-digit verification code')).toHaveCount(0);
    expect(await onlyConnection(user)).toMatchObject({ state: 'reauthentication-required', run: null });
    const rejected = await fixture.account(ACCOUNTS.carol.appleId);
    expect(rejected).toMatchObject({ logins: 1, wrongCodes: 1, inventoryPages: 0, downloadsServed: 0 });
    expect(await assetsOf(user)).toHaveLength(0);

    // The retry: the password again, then the right code.
    await signIn(page, ACCOUNTS.carol);
    await enterCode(page, ACCOUNTS.carol.code);
    await expect(dialog(page)).toBeHidden();
    await expect(notice(page)).toContainText('Account connected. The first sync has started.');
    expect(await connectionState(user)).toBe('connected');

    await expect(badge(page)).toHaveText('Completed', { timeout: RUN_TIMEOUT });
    await expect(results(page)).toContainText(`Imported ${items.length}`);
    expectExactly(await assetsOf(user), items);
    const connected = await fixture.account(ACCOUNTS.carol.appleId);
    expect(connected).toMatchObject({ logins: 2, wrongCodes: 1 });
  });

  test('two Frameleaf users each import only their own Apple account', async ({ browser }) => {
    const alice = await newUser(admin, 'alice');
    const bob = await newUser(admin, 'bob');
    const aliceLibrary = await fixture.library(ACCOUNTS.alice.appleId);
    const bobLibrary = await fixture.library(ACCOUNTS.bob.appleId);
    // Hidden photos are not included by default: neither account's hidden item may arrive.
    const aliceItems = aliceLibrary.filter(({ hidden }) => !hidden);
    const bobItems = bobLibrary.filter(({ hidden }) => !hidden);
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    try {
      await utils.setAuthCookies(aliceContext, alice.accessToken);
      await utils.setAuthCookies(bobContext, bob.accessToken);
      const alicePage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();

      await openICloud(alicePage);
      await connect(alicePage, ACCOUNTS.alice);
      await expect(badge(alicePage)).toHaveText('Completed', { timeout: RUN_TIMEOUT });

      // Bob starts from his own empty page: Alice's connection is not his to see.
      await openICloud(bobPage);
      await connect(bobPage, ACCOUNTS.bob);
      await expect(badge(bobPage)).toHaveText('Completed', { timeout: RUN_TIMEOUT });

      // Each page lists only its own connection and imports, and its timeline only its own photos.
      for (const [page, own, foreign] of [
        [alicePage, aliceItems, [...bobLibrary, ...aliceLibrary.filter(({ hidden }) => hidden)]],
        [bobPage, bobItems, [...aliceLibrary, ...bobLibrary.filter(({ hidden }) => hidden)]],
      ] as const) {
        await page.reload();
        await expect(page.locator('.ic-toolbar select option')).toHaveCount(1);
        await expect(results(page)).toContainText(`Imported ${own.length}`);
        for (const item of own) {
          await expect(results(page).getByText(item.name, { exact: true })).toBeVisible();
        }
        for (const item of foreign) {
          await expect(results(page).getByText(item.name, { exact: true })).toHaveCount(0);
        }
        await page.goto('/photos');
        await expect(thumbnails(page)).toHaveCount(own.length);
      }

      // The API agrees: each library holds exactly its own account's bytes.
      expectExactly(await assetsOf(alice), aliceItems);
      expectExactly(await assetsOf(bob), bobItems);

      // Neither can reach the other's connection.
      const aliceConnection = await onlyConnection(alice);
      const bobConnection = await onlyConnection(bob);
      expect(aliceConnection.id).not.toBe(bobConnection.id);
      await expect(
        getICloudInventory({ id: aliceConnection.id }, { headers: asBearerAuth(bob.accessToken) }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        controlICloudConnection(
          { id: aliceConnection.id, iCloudControlDto: { action: ICloudControlAction.Run } },
          { headers: asBearerAuth(bob.accessToken) },
        ),
      ).rejects.toMatchObject({ status: 404 });
      const { recent } = await getICloudInventory(
        { id: aliceConnection.id },
        { headers: asBearerAuth(alice.accessToken) },
      );
      expect(sorted((recent ?? []).map(({ fileName }) => fileName))).toEqual(
        sorted(aliceItems.map(({ name }) => name)),
      );
    } finally {
      await aliceContext.close();
      await bobContext.close();
    }
  });

  test('a hidden iCloud item imported after relocking stays out of the timeline, in Locked', async ({
    context,
    page,
  }) => {
    const user = await newUser(admin, 'hidden');
    const items = await fixture.library(ACCOUNTS.dana.appleId);
    const visible = items.filter(({ hidden }) => !hidden);
    const [hidden, ...others] = items.filter((item) => item.hidden);
    expect(others).toHaveLength(0);
    await setupPinCode({ pinCodeSetupDto: { pinCode: PIN } }, { headers: asBearerAuth(user.accessToken) });
    await utils.setAuthCookies(context, user.accessToken);
    await openICloud(page);

    // First sync with hidden photos not included (the default): only the visible items arrive.
    await connect(page, ACCOUNTS.dana);
    await expect(badge(page)).toHaveText('Completed', { timeout: RUN_TIMEOUT });
    expectExactly(await assetsOf(user), visible);

    // Include hidden photos: the consent dialog, then the PIN, because they arrive Locked.
    await page.getByLabel('Hidden photos').check();
    await page.getByRole('button', { name: 'Save sync preferences' }).click();
    await page.getByRole('button', { name: 'Allow and save' }).click();
    await page.waitForURL(/\/auth\/pin-prompt/);
    await page.locator('.pin-input').first().focus();
    await page.keyboard.type(PIN);
    await expect.poll(() => isElevated(user)).toBe(true);
    // FL-290: the prompt returns to the iCloud Photos section itself, query string included.
    await page.waitForURL((url) => url.pathname === '/user-settings' && url.searchParams.get('section') === 'icloud');
    // Back on the connection, the preferences come back and are saved.
    await expect(notice(page)).toContainText('Unlocked. Your sync preferences are back; save them to finish.');
    await expect(page.getByLabel('Hidden photos')).toBeChecked();
    await page.getByRole('button', { name: 'Save sync preferences' }).click();
    await expect(notice(page)).toContainText('Connection updated.');
    const saved = await onlyConnection(user);
    expect(saved.config.includeHidden).toBe(true);

    // Relock before the hidden item is imported.
    await page.getByRole('button', { name: 'Hide Locked content' }).first().click();
    await expect.poll(() => isElevated(user)).toBe(false);
    await expect(page.getByRole('button', { name: 'Unlock Locked content' }).first()).toBeVisible();
    // Locking always reloads the whole document onto Photos; the owner goes back to the connection.
    await page.waitForURL((url) => url.pathname === '/photos');
    await openICloud(page);
    await expect(page.getByLabel('Hidden photos')).toBeChecked();

    await control(page, 'Sync now').click();
    await expect(notice(page)).toContainText('Sync started.');
    await expect(badge(page)).toHaveText('Completed', { timeout: RUN_TIMEOUT });
    const run = await runOf(user);
    expect(run?.status).toBe(MediaOperationStatus.Completed);
    expect(await isElevated(user)).toBe(false);

    // Locked session: the hidden item is nowhere — not in the results, the timeline or the API.
    await page.reload();
    for (const item of visible) {
      await expect(results(page).getByText(item.name, { exact: true })).toBeVisible();
    }
    await expect(results(page).getByText(hidden.name)).toHaveCount(0);
    expectExactly(await assetsOf(user), visible);
    await page.goto('/photos');
    await expect(thumbnails(page)).toHaveCount(visible.length);
    await expect(page.getByText(hidden.name)).toHaveCount(0);

    // It did arrive — Locked. Unlocked, the owner finds it in Locked, byte for byte, exactly once.
    await unlockAuthSession({ sessionUnlockDto: { pinCode: PIN } }, { headers: asBearerAuth(user.accessToken) });
    const unlocked = await assetsOf(user);
    expectExactly(unlocked, items);
    const locked = unlocked.find(({ originalFileName }) => originalFileName === hidden.name);
    expect(locked?.visibility).toBe('locked');
    await page.goto('/locked');
    await expect(page.locator(`[data-asset-id="${locked?.id}"]`)).toBeVisible();
    await expect(thumbnails(page)).toHaveCount(1);
  });

  test('reloading the page mid-run follows the same run to the end, without duplicates', async ({ context, page }) => {
    const user = await newUser(admin, 'reload');
    const items = await fixture.library(ACCOUNTS.erin.appleId);
    await utils.setAuthCookies(context, user.accessToken);
    // Let two downloads through, then hold the third: the run is mid-way when the page reloads.
    await fixture.hold(ACCOUNTS.erin.appleId, 2);
    let runId: string | undefined;
    try {
      await openICloud(page);
      await connect(page, ACCOUNTS.erin);
      await expect.poll(() => downloadsWaiting(ACCOUNTS.erin), { timeout: 60_000 }).toBe(1);
      await expect(badge(page)).toHaveText('Syncing', { timeout: 15_000 });
      await expect(runPanel(page)).toContainText(`2 of ${items.length} items settled`, { timeout: 15_000 });
      const before = await runOf(user);
      expect(before?.status).toBe(MediaOperationStatus.Rendering);
      runId = before?.id;
      expect(await assetsOf(user)).toHaveLength(2);

      await page.reload();
      // After the reload the page shows the same run, still going, from the server.
      await expect(badge(page)).toHaveText('Syncing');
      await expect(runPanel(page)).toContainText(`2 of ${items.length} items settled`);
      const during = await runOf(user);
      expect(during?.id).toBe(runId);
    } finally {
      await fixture.release(ACCOUNTS.erin.appleId);
    }

    // It carries on by itself and finishes; the reloaded page follows it to the end.
    await expect(badge(page)).toHaveText('Completed', { timeout: RUN_TIMEOUT });
    await expect(runPanel(page)).toContainText(`${items.length} of ${items.length} items settled`);
    const after = await runOf(user);
    expect(after?.id).toBe(runId);
    expectExactly(await assetsOf(user), items);
    // every item was downloaded exactly once
    const { served } = await fixture.account(ACCOUNTS.erin.appleId);
    expect(served).toEqual(Object.fromEntries(items.map(({ name }) => [name, 1])));

    await page.reload();
    await expect(results(page)).toContainText(`Imported ${items.length}`);
  });

  test('cancelling stops the run and leaves no partial or duplicate imports', async ({ context, page }) => {
    const user = await newUser(admin, 'cancel');
    const items = await fixture.library(ACCOUNTS.frank.appleId);
    await utils.setAuthCookies(context, user.accessToken);
    // One download through, the second held: the run is busy with an item when it is cancelled.
    await fixture.hold(ACCOUNTS.frank.appleId, 1);
    try {
      await openICloud(page);
      await connect(page, ACCOUNTS.frank);
      await expect.poll(() => downloadsWaiting(ACCOUNTS.frank), { timeout: 60_000 }).toBe(1);
      await expect(badge(page)).toHaveText('Syncing', { timeout: 15_000 });

      await control(page, 'Cancel').click();
      await expect(notice(page)).toContainText('Sync cancelled. Photos already imported are unchanged.');
      await expect(badge(page)).toHaveText('Cancelling');
    } finally {
      // The download in flight finishes; the run stops at the next checkpoint.
      await fixture.release(ACCOUNTS.frank.appleId);
    }

    await expect(badge(page)).toHaveText('Cancelled', { timeout: 60_000 });
    const cancelled = await runOf(user);
    expect(cancelled?.status).toBe(MediaOperationStatus.Cancelled);
    // Only the item already downloading completed; each import is whole and appears once.
    const atCancel = await fixture.account(ACCOUNTS.frank.appleId);
    expect(atCancel.downloadsServed).toBe(2);
    expectExactly(
      await assetsOf(user),
      items.filter(({ name }) => atCancel.served[name] === 1),
    );
    // Nothing keeps downloading or importing behind a cancelled run.
    await page.waitForTimeout(5000);
    const later = await fixture.account(ACCOUNTS.frank.appleId);
    expect(later.downloadsServed).toBe(2);
    expect(await assetsOf(user)).toHaveLength(2);

    // Retrying finishes the rest: the two already imported are matched, never downloaded again.
    await expect(control(page, 'Retry')).toBeEnabled();
    await control(page, 'Retry').click();
    await expect(notice(page)).toContainText('Retry started for the items that did not finish.');
    await expect(badge(page)).toHaveText('Completed', { timeout: RUN_TIMEOUT });
    expectExactly(await assetsOf(user), items);
    const { served } = await fixture.account(ACCOUNTS.frank.appleId);
    expect(served).toEqual(Object.fromEntries(items.map(({ name }) => [name, 1])));
  });
});
