import { LoginResponseDto, setUserOnboarding, updateUserPreferencesAdmin } from '@frameleaf/sdk';
import { expect, Page, test } from '@playwright/test';
import { createUserDto, loginDto } from 'src/fixtures.js';
import { asBearerAuth, utils } from 'src/utils.js';

/**
 * FL-30 validation: the production shell in a real browser against a real server. Every rail
 * destination opens a page (never the error page) and marks itself current, deep links and the
 * browser's Back and Forward keep the rail in step, the collapsed rail is remembered, a
 * destination the account turned off leaves the rail but not the product, the repair utilities
 * live in Library Care rather than the rail, and the access roles hold at the route boundary.
 * Prototype: `design/frameleaf/template/src/LibraryRail.jsx` and the `App.jsx` header.
 */

const rail = (page: Page) => page.getByRole('navigation', { name: 'Library navigation' });
const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const errorTitle = (page: Page) => page.locator('#frameleaf-error-title');
/** Whether the page is at `href`: same path, and every query value `href` names (pages add their own, like `fl`). */
const isAt = (url: URL, href: string) => {
  const target = new URL(href, url);
  return (
    url.pathname === target.pathname &&
    [...target.searchParams].every(([key, value]) => url.searchParams.get(key) === value)
  );
};
const at = (href: string) => (url: URL) => isAt(url, href);
const railLink = (page: Page, name: string) => rail(page).getByRole('link', { name, exact: true });

test.describe('Frameleaf shell navigation (FL-30)', () => {
  let admin: LoginResponseDto;
  let member: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    member = await utils.userSetup(admin.accessToken, createUserDto.create('shell-member'));
    await utils.createAsset(admin.accessToken);
    // No preference is set: every destination the prototype shows is on by default (FL-146, owner
    // decision 2026-09-27), and a later test turns some off again.
    // The one-time "Set up your account" page is FL-176's; these tests start after it.
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(admin.accessToken) });
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(member.accessToken) });
  });

  test('opens every rail destination as a page of its own and marks it current', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');
    await expect(railLink(page, 'Library')).toHaveAttribute('aria-current', 'page');

    // LibraryRail.jsx: the Library section opens the rail in this order, before Explore.
    const firstSection = await rail(page)
      .getByRole('link')
      .evaluateAll((links) => links.slice(0, 6).map((link) => link.textContent?.trim()));
    expect(firstSection).toEqual(['Library', 'Favorites', 'Recently added', 'Best Photos', 'Archive', 'Locked']);

    const links = await rail(page)
      .getByRole('link')
      .evaluateAll((links) =>
        links.map((link) => ({
          name: (link.getAttribute('aria-label') ?? link.textContent ?? '').trim(),
          href: link.getAttribute('href') ?? '',
        })),
      );
    // The Albums and Shared spaces "+" open the create dialog; they are not destinations.
    const destinations = links.filter(({ name }) => !['New album', 'New shared space'].includes(name));
    const names = destinations.map(({ name }) => name);
    expect(new Set(names).size, 'no destination is listed twice').toBe(names.length);
    // LibraryRail.jsx (September 24): Library, Explore, Albums, Shared spaces, Tools, then Care, Settings, Support.
    expect(names).toEqual([
      'Library',
      'Favorites',
      'Recently added',
      'Best Photos',
      'Archive',
      'Locked',
      'Explore',
      'People',
      'Pets',
      'Memories',
      'Places',
      'Map',
      'Tags',
      'Folders',
      'Documents',
      'All albums',
      'Shared links',
      'Photography',
      'Workflows',
      'Trash',
      'Library Care',
      'Settings',
      'Support Frameleaf',
    ]);

    for (const { name, href } of destinations) {
      await test.step(name, async () => {
        const previous = page.url();
        await railLink(page, name).click();
        if (name === 'Locked') {
          // Locked is gated: without an unlocked session it asks for the PIN first, then continues
          // to Locked. Back returns to the page the rail was used from.
          await page.waitForURL(
            (url) => url.pathname === '/auth/pin-prompt' && url.searchParams.get('continue') === href,
          );
          await expect(errorTitle(page)).toHaveCount(0);
          await page.goBack();
          await page.waitForURL(at(previous));
          return;
        }
        await page.waitForURL(at(href));
        await expect(errorTitle(page), `${name} (${href}) opens a page`).toHaveCount(0);
        if (new URL(page.url()).pathname === '/user-settings') {
          // Tools, Library Care and Settings open Command Center areas, which bring their own
          // navigation in place of the library rail (CommandCenter.jsx); Back returns to the rail.
          await expect(page.getByRole('navigation', { name: 'Settings navigation' })).toBeVisible();
          await page.goBack();
          await page.waitForURL(at(previous));
          return;
        }
        if (name === 'Photography') {
          // Like Studio, the photography workspace is a full-page tool without the library rail (App.jsx).
          await expect(rail(page)).toHaveCount(0);
          await page.goBack();
          await page.waitForURL(at(previous));
          return;
        }
        if (name === 'Support Frameleaf') {
          // The prototype's Buy screen is one of its full-page auth screens (App.jsx AUTH_SCREENS).
          await expect(page.getByRole('heading', { level: 1, name: 'Support Frameleaf' })).toBeVisible();
          await expect(rail(page)).toHaveCount(0);
          await page.goBack();
          await page.waitForURL(at(previous));
          return;
        }
        await expect(railLink(page, name)).toHaveAttribute('aria-current', 'page');
      });
    }
  });

  test('keeps the rail in step with a deep link and the browser history', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/favorites');
    await expect(railLink(page, 'Favorites')).toHaveAttribute('aria-current', 'page');

    await railLink(page, 'Archive').click();
    await page.waitForURL(at('/archive'));
    await expect(railLink(page, 'Archive')).toHaveAttribute('aria-current', 'page');

    await page.goBack();
    await page.waitForURL(at('/favorites'));
    await expect(railLink(page, 'Favorites')).toHaveAttribute('aria-current', 'page');
    await expect(railLink(page, 'Archive')).not.toHaveAttribute('aria-current', 'page');

    await page.goForward();
    await page.waitForURL(at('/archive'));
    await expect(railLink(page, 'Archive')).toHaveAttribute('aria-current', 'page');
  });

  test('switches between Library, Studio and Activity, and Back returns', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');
    await expect(primary(page).getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');

    await primary(page).getByRole('link', { name: 'Studio' }).click();
    await page.waitForURL(at('/studio/projects'));
    await expect(errorTitle(page)).toHaveCount(0);
    await expect(primary(page).getByRole('link', { name: 'Studio' })).toHaveAttribute('aria-current', 'page');
    // Studio has no library rail, as in the prototype.
    await expect(rail(page)).toHaveCount(0);

    await primary(page).getByRole('link', { name: 'Activity' }).click();
    await page.waitForURL(at('/activity'));
    await expect(errorTitle(page)).toHaveCount(0);
    await expect(primary(page).getByRole('link', { name: 'Activity' })).toHaveAttribute('aria-current', 'page');

    await page.goBack();
    await page.waitForURL(at('/studio/projects'));
    await page.goBack();
    await page.waitForURL(at('/photos'));
    await expect(railLink(page, 'Library')).toHaveAttribute('aria-current', 'page');
  });

  test('remembers the collapsed rail on this device', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');

    await rail(page).getByRole('button', { name: 'Collapse navigation' }).click();
    await expect(rail(page).getByRole('button', { name: 'Expand navigation' })).toBeVisible();

    await page.reload();
    const expand = rail(page).getByRole('button', { name: 'Expand navigation' });
    await expect(expand).toBeVisible();
    // The icon-only rail still names and reaches its destinations.
    await railLink(page, 'Favorites').click();
    await page.waitForURL(at('/favorites'));

    await expand.click();
    await expect(rail(page).getByRole('button', { name: 'Collapse navigation' })).toBeVisible();
    await page.reload();
    await expect(rail(page).getByRole('button', { name: 'Collapse navigation' })).toBeVisible();
  });

  test('drops a destination the account turned off, while its address still opens', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await utils.updateMyPreferences(admin.accessToken, {
      people: { enabled: true, sidebarWeb: false },
      memories: { enabled: false, sidebarWeb: true },
    });
    try {
      await page.goto('/photos');
      await expect(railLink(page, 'Library')).toBeVisible();
      await expect(railLink(page, 'People')).toHaveCount(0);
      await expect(railLink(page, 'Memories')).toHaveCount(0);
      await expect(railLink(page, 'Places')).toBeVisible();

      // A display choice, never an access control: the deep link still works.
      await page.goto('/people');
      await expect(errorTitle(page)).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'People library' })).toBeVisible();
    } finally {
      await utils.updateMyPreferences(admin.accessToken, {
        people: { enabled: true, sidebarWeb: true },
        memories: { enabled: true, sidebarWeb: true },
      });
    }
  });

  // FL-146 (owner decision 2026-09-27): "Whatever the prototype displays, that should be default,
  // they can be hidden by the admin." A new account that never changed a preference.
  test("shows a new account every destination the prototype's rail and tab bar show", async ({ context, page }) => {
    await utils.setAuthCookies(context, member.accessToken);
    await page.goto('/photos');
    for (const name of ['Recently added', 'People', 'Memories', 'Tags', 'Folders', 'Shared links']) {
      await expect(railLink(page, name), name).toBeVisible();
    }

    // App.jsx `fl-tabbar`: Library, Memories, Albums, Search on a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    const tabs = page.getByRole('navigation', { name: 'Sections' });
    await expect(tabs).toBeVisible();
    await expect(tabs.locator(':scope > a, :scope > button')).toHaveText(['Library', 'Memories', 'Albums', 'Search']);
  });

  test("lets an administrator hide a default destination from an account's rail", async ({ context, page }) => {
    const hide = (sidebarWeb: boolean) =>
      updateUserPreferencesAdmin(
        {
          id: member.userId,
          userPreferencesUpdateDto: { tags: { sidebarWeb }, recentlyAdded: { sidebarWeb }, memories: { sidebarWeb } },
        },
        { headers: asBearerAuth(admin.accessToken) },
      );
    await utils.setAuthCookies(context, member.accessToken);
    await hide(false);
    try {
      await page.goto('/photos');
      await expect(railLink(page, 'Library')).toBeVisible();
      await expect(railLink(page, 'Tags')).toHaveCount(0);
      await expect(railLink(page, 'Recently added')).toHaveCount(0);
      await expect(railLink(page, 'Memories')).toHaveCount(0);
      await expect(railLink(page, 'Folders')).toBeVisible();

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole('navigation', { name: 'Sections' }).getByText('Memories')).toHaveCount(0);

      // A display choice, never an access control: the page still opens.
      await page.goto('/tags');
      await expect(errorTitle(page)).toHaveCount(0);
    } finally {
      await hide(true);
    }
  });

  test('keeps the repair utilities in Library Care, not in the rail', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');

    for (const name of [/duplicate/i, /large files/i, /live photo/i]) {
      await expect(rail(page).getByRole('link', { name })).toHaveCount(0);
    }

    await railLink(page, 'Library Care').click();
    await page.waitForURL((url) => url.pathname === '/user-settings' && url.searchParams.get('area') === 'care');
    await expect(errorTitle(page)).toHaveCount(0);
    await expect(page.getByText('Duplicate review', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Live Photo pairing', { exact: true }).first()).toBeVisible();
  });

  test('keeps administration behind the administrator role', async ({ context, page }) => {
    await utils.setAuthCookies(context, member.accessToken);
    await page.goto('/admin/users');
    await page.waitForURL((url) => !url.pathname.startsWith('/admin'));
    await expect(page).not.toHaveURL(/area=users/);

    await page.goto('/photos');
    await expect(railLink(page, 'Library')).toHaveAttribute('aria-current', 'page');
    await expect(railLink(page, 'Settings')).toBeVisible();
  });

  test('shows the Frameleaf error page for an address that does not exist', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/this-page-does-not-exist');

    await expect(errorTitle(page)).toHaveText('We can’t find that page');
    await expect(page).toHaveTitle(/Frameleaf/);
    await expect(page).not.toHaveTitle(/Immich/i);
  });

  test('sends a signed-out visitor to the Frameleaf sign-in and back to the deep link', async ({ page }) => {
    await page.goto('/favorites');
    await page.waitForURL('**/auth/login**');
    await expect(page).not.toHaveTitle(/Immich/i);
    // Light surfaces use a text wordmark; dark surfaces use the named lockup image.
    await expect(
      page.getByRole('img', { name: 'Frameleaf', exact: true }).or(page.getByText('Frameleaf', { exact: true })),
    ).toBeVisible();

    await page.getByLabel('Email', { exact: true }).fill(loginDto.admin.email);
    await page.getByLabel('Password', { exact: true }).fill(loginDto.admin.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(at('/favorites'));
    await expect(railLink(page, 'Favorites')).toHaveAttribute('aria-current', 'page');
  });
});
