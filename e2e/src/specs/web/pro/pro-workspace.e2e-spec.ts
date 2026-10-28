import AxeBuilder from '@axe-core/playwright';
import {
  addBookmarksToAlbum,
  AlbumUserRole,
  createAlbum,
  createBookmark,
  getMyUser,
  LibraryScope,
  setUserOnboarding,
  type LoginResponseDto,
} from '@frameleaf/sdk';
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { asBearerAuth, utils } from 'src/utils.js';

/** Real API records: links stay links, and private notes never become shared search matches. */
test.describe('Free Pro workspace', () => {
  test.use({ reducedMotion: 'reduce' });
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  const account = async () => {
    const suffix = randomUUID();
    const user = await utils.userSetup(admin.accessToken, {
      email: `pro-${suffix}@example.com`,
      name: 'Designer',
      password: 'password',
    });
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(user.accessToken) });
    return user;
  };

  test('collects and searches a private note without a Pro entitlement', async ({ page, context }) => {
    const owner = await account();
    const auth = { headers: asBearerAuth(owner.accessToken) };
    const user = await getMyUser(auth);
    expect(user.license?.activatedAt).toBeFalsy();
    const title = `Reference ${randomUUID()}`;
    const note = `packaging-${randomUUID()}`;
    await createBookmark(
      { bookmarkCreateDto: { title, note, url: 'https://example.com/reference', libraryScope: LibraryScope.Design } },
      auth,
    );
    await utils.setAuthCookies(context, owner.accessToken);
    await page.goto('/pro');
    const card = page.getByRole('button', { name: title, exact: true });
    await card.focus();
    await card.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(note);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(card).toBeFocused();
    await page.getByTestId('search-entry').click();
    const input = page.getByRole('combobox', { name: 'Search query' });
    await input.fill(note);
    const searched = page.waitForRequest(
      (request) =>
        request.url().includes('/library/items/search') &&
        request.method() === 'POST' &&
        request.postDataJSON().limit === 100 &&
        request.postDataJSON().filter?.text?.contains === note,
    );
    await input.press('Enter');
    await searched;
    await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Search', exact: true })).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect
      .poll(async () => {
        const clear = await page.getByRole('button', { name: 'Clear all', exact: true }).boundingBox();
        return clear ? clear.x + clear.width : Infinity;
      })
      .toBeLessThanOrEqual(390);
    const chip = page.getByTestId('frameleaf-filter-chips').locator('.search-chip');
    await expect
      .poll(async () => {
        const label = await chip.locator('.open').boundingBox();
        const bounds = await chip.boundingBox();
        return !!label && !!bounds && label.x + label.width <= bounds.x + bounds.width;
      })
      .toBe(true);
    for (const name of ['Switch to dark theme', 'Switch to light theme']) {
      const toggle = page.getByRole('button', { name, exact: true });
      if (await toggle.isVisible()) {
        await toggle.click();
      }
      await expect(page.locator('section.fl-items-view')).toHaveAttribute(
        'data-theme',
        name.includes('dark') ? 'dark' : 'light',
      );
      await page.evaluate(() =>
        Promise.allSettled(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished),
        ),
      );
      await page.screenshot({
        path: test.info().outputPath(`pro-phone-${name.includes('dark') ? 'dark' : 'light'}.png`),
        fullPage: true,
      });
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(
        violations
          .filter(({ impact }) => impact === 'serious' || impact === 'critical')
          .map(({ id, nodes }) => ({
            id,
            nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
          })),
      ).toEqual([]);
    }
  });

  test('a shared album member sees the link but cannot read or search its owner note', async ({ page, context }) => {
    const owner = await account();
    const viewer = await account();
    const auth = { headers: asBearerAuth(owner.accessToken) };
    const title = `Shared reference ${randomUUID()}`;
    const secret = `private-${randomUUID()}`;
    const bookmark = await createBookmark(
      {
        bookmarkCreateDto: {
          title,
          note: secret,
          url: 'https://example.com/reference',
          libraryScope: LibraryScope.Design,
        },
      },
      auth,
    );
    const album = await createAlbum(
      {
        createAlbumDto: {
          albumName: 'Shared references',
          libraryScope: LibraryScope.Design,
          albumUsers: [{ userId: viewer.userId, role: AlbumUserRole.Viewer }],
        },
      },
      auth,
    );
    await addBookmarksToAlbum({ id: album.id, bookmarkIdsDto: { ids: [bookmark.id] } }, auth);
    await utils.setAuthCookies(context, viewer.accessToken);
    await page.goto(`/albums/${album.id}`);
    await expect(page.locator('.summary')).toContainText('1 item');
    await page.getByRole('button', { name: title, exact: true }).click();
    await expect(page.getByRole('link', { name: 'Open website' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveCount(0);
    await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByTestId('search-entry').click();
    const input = page.getByRole('combobox', { name: 'Search query' });
    await input.fill(secret);
    const searched = page.waitForResponse(
      (response) =>
        response.url().includes('/library/items/search') &&
        response.request().postDataJSON()?.filter?.text?.contains === secret &&
        response.request().postDataJSON()?.limit === 100,
    );
    await input.press('Enter');
    const response = await searched;
    const result = await response.json();
    expect(result.count).toBe(0);
    await expect(page.getByRole('button', { name: title, exact: true })).toHaveCount(0);
  });
});
