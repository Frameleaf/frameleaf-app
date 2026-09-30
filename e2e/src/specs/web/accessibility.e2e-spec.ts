import AxeBuilder from '@axe-core/playwright';
import { LoginResponseDto } from '@immich/sdk';
import { expect, Page, test } from '@playwright/test';
import { utils } from 'src/utils.js';

/**
 * FL-139 (QA-103, web): the key pages in a real browser.
 * - axe (WCAG 2.1 A/AA rules) finds no serious or critical violation; lesser ones are attached to the
 *   report so they stay visible without failing the run.
 * - Under prefers-reduced-motion no Web Animation runs when a menu or dialog opens: Svelte transitions
 *   use element.animate(), which the CSS kill-switch cannot stop, so this checks the JS gating.
 * - A right-to-left language puts dir="rtl" and its lang on the page, and the shell does not scroll
 *   sideways. In the viewer its arrows point, and its arrow keys move, the way the page reads.
 */
const PAGES = [
  { name: 'library', path: '/photos' },
  { name: 'albums', path: '/albums' },
  { name: 'people', path: '/people' },
  { name: 'explore', path: '/explore' },
  { name: 'sharing', path: '/sharing' },
  { name: 'settings', path: '/user-settings' },
  { name: 'studio projects', path: '/studio/projects' },
];

const audit = async (page: Page, name: string) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // the map canvas is a third-party WebGL surface with its own controls
    .exclude('.maplibregl-canvas')
    .analyze();
  const blocking = results.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  test.info().annotations.push({
    type: 'axe',
    description: `${name}: ${results.violations.map(({ id, impact, nodes }) => `${id} (${impact}, ${nodes.length})`).join(', ') || 'no violations'}`,
  });
  expect(
    blocking.map(({ id, help, nodes }) => ({
      id,
      help,
      targets: nodes.slice(0, 5).map(({ target }) => target.join(' ')),
    })),
    `${name} has serious or critical accessibility violations`,
  ).toEqual([]);
};

/** Web Animations that are actually running (a finished or zero-length one does not count). */
const runningAnimations = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return animation.playState === 'running' && Number(timing?.duration ?? 0) > 0;
      })
      .map((animation) => (animation as CSSAnimation).animationName ?? animation.constructor.name),
  );

test.describe('Accessibility of the key web pages (FL-139)', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    for (let index = 0; index < 3; index++) {
      await utils.createAsset(admin.accessToken);
    }
  });

  test('the sign-in page', async ({ page }) => {
    await page.goto('/auth/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await audit(page, 'sign-in');
  });

  for (const { name, path } of PAGES) {
    test(`the ${name} page`, async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('#frameleaf-error-title')).toHaveCount(0);
      await audit(page, name);
    });
  }

  test('the photo viewer', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    const asset = await utils.createAsset(admin.accessToken);
    await page.goto(`/photos/${asset.id}`);
    await expect(page.locator('#immich-asset-viewer')).toHaveAttribute('data-asset-id', asset.id);
    await audit(page, 'photo viewer');
  });

  test('no animation runs under reduced motion when a menu and a dialog open', async ({ context, page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/albums');
    await page.waitForLoadState('networkidle');

    // the account menu and the create-album dialog are the shell's most used popups
    await page.getByRole('button', { name: /^Account menu/ }).click();
    await expect.poll(() => runningAnimations(page), { timeout: 2000 }).toEqual([]);
    await page.keyboard.press('Escape');

    await page.goto('/albums?create=album');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect.poll(() => runningAnimations(page), { timeout: 2000 }).toEqual([]);
  });

  test('a right-to-left language turns the page around without sideways scrolling', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.addInitScript(() => localStorage.setItem('lang', 'ar'));
    await page.goto('/photos');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('a right-to-left viewer points its arrows and its arrow keys the way the page reads', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.addInitScript(() => localStorage.setItem('lang', 'ar'));
    const assets = await Promise.all([0, 1].map(() => utils.createAsset(admin.accessToken)));
    const ids = assets.map(({ id }) => id);
    // the Arabic labels of the viewer's next button (i18n/ar.json view_next_asset)
    const next = page.getByRole('button', { name: 'عرض المحتوى التالي' });
    const viewer = page.locator('#immich-asset-viewer');

    // start from an item that has a next one, whatever order the timeline puts them in
    let start = '';
    for (const id of ids) {
      await page.goto(`/photos/${id}`);
      await expect(viewer).toHaveAttribute('data-asset-id', id);
      if (await next.isVisible()) {
        start = id;
        break;
      }
    }
    expect(start, 'an item with a next one').not.toBe('');

    // the "next" chevron is mirrored, so it points left, the way an Arabic page reads
    await expect(next.locator('svg')).toHaveCSS('scale', '-1 1');

    await next.click();
    await expect(viewer).not.toHaveAttribute('data-asset-id', start);
    const following = await viewer.getAttribute('data-asset-id');

    // and ← goes forward to the same item
    await page.goto(`/photos/${start}`);
    await expect(viewer).toHaveAttribute('data-asset-id', start);
    await page.keyboard.press('ArrowLeft');
    await expect(viewer).toHaveAttribute('data-asset-id', following!);
  });
});
