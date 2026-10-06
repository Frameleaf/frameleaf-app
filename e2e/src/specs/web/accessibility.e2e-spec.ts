import AxeBuilder from '@axe-core/playwright';
import { LoginResponseDto } from '@frameleaf/sdk';
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
/**
 * FL-139: the library, administration and Studio surfaces (story: "RTL and long-string fixtures cover
 * full library/admin/studio surfaces"). Each is audited with axe, and opened right to left (Arabic)
 * and with long strings (German) without scrolling sideways.
 */
const PAGES = [
  // library
  { name: 'library', path: '/photos' },
  { name: 'albums', path: '/albums' },
  { name: 'people', path: '/people' },
  { name: 'explore', path: '/explore' },
  { name: 'sharing', path: '/sharing' },
  { name: 'favorites', path: '/favorites' },
  { name: 'archive', path: '/archive' },
  { name: 'trash', path: '/trash' },
  { name: 'map', path: '/map' },
  { name: 'tags', path: '/tags' },
  { name: 'folders', path: '/folders' },
  { name: 'places', path: '/places' },
  { name: 'search results', path: '/search?query=%7B%22originalFileName%22%3A%22a%22%7D' },
  { name: 'shared links', path: '/shared-links' },
  { name: 'activity', path: '/activity' },
  { name: 'utilities', path: '/utilities' },
  { name: 'duplicates', path: '/utilities/duplicates' },
  { name: 'large files', path: '/utilities/large-files' },
  { name: 'settings', path: '/user-settings' },
  // administration
  { name: 'system settings', path: '/admin/system-settings' },
  { name: 'user management', path: '/admin/user-management' },
  { name: 'job queues', path: '/admin/queues' },
  { name: 'server status', path: '/admin/server-status' },
  { name: 'external libraries', path: '/admin/library-management' },
  // Studio
  { name: 'studio projects', path: '/studio/projects' },
  { name: 'studio editor', path: '/studio' },
];

/** Right to left, and the long strings of German, over every surface above. */
const LANGUAGES = [
  { lang: 'ar', dir: 'rtl', label: 'right to left (Arabic)' },
  { lang: 'de', dir: 'ltr', label: 'long strings (German)' },
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

  for (const { lang, dir, label } of LANGUAGES) {
    test(`every surface opens ${label} without scrolling sideways`, async ({ context, page }) => {
      test.setTimeout(PAGES.length * 15_000);
      await utils.setAuthCookies(context, admin.accessToken);
      await page.addInitScript((code) => localStorage.setItem('lang', code), lang);
      const problems: string[] = [];
      for (const { name, path } of PAGES) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await expect(page.locator('html'), name).toHaveAttribute('dir', dir);
        if ((await page.locator('#frameleaf-error-title').count()) > 0) {
          problems.push(`${name}: error page`);
          continue;
        }
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (overflow > 1) {
          problems.push(`${name}: scrolls ${overflow}px sideways`);
        }
      }
      expect(problems).toEqual([]);
    });
  }

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
      // the next item is looked up after the viewer opens, so give its button time to appear
      let hasNext = true;
      try {
        await next.waitFor({ state: 'visible', timeout: 5000 });
      } catch {
        hasNext = false;
      }
      if (hasNext) {
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
