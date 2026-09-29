import {
  AssetMediaResponseDto,
  LoginResponseDto,
  createStudioProject,
  getStudioProject,
  releaseStudioProjectLease,
  saveStudioProjectRevision,
} from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { asBearerAuth, utils } from 'src/utils.js';

/**
 * FL-88 (STU-201): the Studio route against a real server. The vendored engine is not part of
 * this build, so the route must mount its chrome, say plainly that the editor is unavailable and
 * name the missing workers, keep the header working (rename, Library, Activity) and leave cleanly.
 * Design: design/frameleaf/template/src/Studio.jsx:2584-2647 (September 24, 2026).
 */
test.describe('Studio', () => {
  let admin: LoginResponseDto;
  let asset: AssetMediaResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    asset = await utils.createAsset(admin.accessToken);
  });

  test.beforeEach(async ({ context }) => {
    await utils.setAuthCookies(context, admin.accessToken);
  });

  test('mounts the chrome and names what the deployment is missing', async ({ page }) => {
    await page.goto(`/studio?assets=${asset.id}`);
    const studio = page.getByRole('region', { name: 'Studio' });
    await expect(studio).toBeVisible();
    await expect(studio.getByText('Editing as', { exact: false })).toBeVisible();
    await expect(page.getByTestId('studio-state')).toHaveAttribute('data-phase', 'unavailable');
    // No render worker is admitted in the e2e stack, so the state lists what is missing.
    await expect(page.getByRole('list', { name: /missing/i })).toBeVisible();
    // The editor's mode switch needs the engine, so it is not offered.
    await expect(page.getByRole('radiogroup', { name: 'Editing mode' })).toHaveCount(0);
  });

  test('renames the draft from the header and goes back to the library', async ({ page }) => {
    await page.goto('/studio');
    const name = page.getByRole('textbox', { name: 'Project name' });
    await name.fill('Lake trip');
    await name.press('Enter');
    await expect(name).toHaveValue('Lake trip');

    // The header's back button (Studio.jsx:2793-2796); the top bar's "Search your library" also
    // contains "Library", so the click is scoped to Studio and matched exactly.
    await page
      .getByRole('region', { name: 'Studio' })
      .getByRole('button', { name: 'Library', exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/photos/);
  });

  test('FL-144 preserves the former writer’s graph as a copy after lease takeover and a history restore', async ({
    browser,
    page,
    baseURL,
  }) => {
    // Wait for the real 30-second lease renewal to discover the takeover; do not fake a 409.
    test.setTimeout(90_000);
    const options = { headers: asBearerAuth(admin.accessToken) };
    const clientId = randomUUID();
    const envelope = (version: number) => ({
      schemaVersion: 1,
      engine: 'freecut',
      engineRevision: '4d62e8082c5eb387a96275bcbd323d28f6e41a62',
      graph: { tracks: [], items: [], fixtureVersion: version },
    });
    const project = await createStudioProject(
      {
        studioProjectCreateDto: {
          name: 'Lease conflict history',
          clientId,
          requestKey: randomUUID(),
          envelope: envelope(1),
        },
      },
      options,
    );
    // Real revision writes cross the History panel's page size of 20.
    for (let revision = 2; revision <= 21; revision++) {
      const saved = await saveStudioProjectRevision(
        {
          id: project.id,
          studioProjectSaveDto: {
            clientId,
            expectedRevision: revision - 1,
            requestKey: randomUUID(),
            envelope: envelope(revision),
          },
        },
        options,
      );
      expect(saved.revision).toBe(revision);
    }
    await releaseStudioProjectLease({ id: project.id, studioProjectLeaseRequestDto: { clientId } }, options);

    await page.goto(`/studio?project=${project.id}`);
    const studio = page.getByRole('region', { name: 'Studio', exact: true });
    await expect(studio.getByText('All changes saved', { exact: true })).toBeVisible();
    await studio.getByRole('button', { name: 'Review', exact: true }).click();
    const history = page.getByRole('complementary', { name: 'History', exact: true });
    await expect(history.locator('ol strong')).toHaveText(
      Array.from({ length: 20 }, (_, index) => `Version ${21 - index}`),
    );
    await history.getByRole('button', { name: 'Show more', exact: true }).click();
    await expect(history.locator('ol strong')).toHaveText(
      Array.from({ length: 21 }, (_, index) => `Version ${21 - index}`),
    );
    await expect(history.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);

    const otherContext = await browser.newContext({ baseURL });
    try {
      await utils.setAuthCookies(otherContext, admin.accessToken);
      const other = await otherContext.newPage();
      await other.goto(`/studio?project=${project.id}`);
      const otherBanner = other.getByTestId('studio-save-banner');
      await expect(otherBanner).toHaveAttribute('data-status', 'lease-lost');
      const reacquire = other.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/studio/projects/${project.id}/lease` &&
          response.request().method() === 'POST',
      );
      await otherBanner.getByRole('button', { name: 'Try editing here again', exact: true }).click();
      expect((await reacquire).status()).toBe(409);
      await expect(otherBanner).toHaveAttribute('data-status', 'lease-lost');

      await otherBanner.getByRole('button', { name: 'Edit here instead', exact: true }).click();
      await expect(otherBanner).toHaveCount(0);
      await other
        .getByRole('region', { name: 'Studio', exact: true })
        .getByRole('button', { name: 'Review', exact: true })
        .click();
      const otherHistory = other.getByRole('complementary', { name: 'History', exact: true });
      const version20 = otherHistory
        .getByRole('listitem')
        .filter({ has: other.getByText('Version 20', { exact: true }) });
      const restored = other.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/studio/projects/${project.id}/restore` &&
          response.request().method() === 'POST',
      );
      await version20.getByRole('button', { name: 'Restore', exact: true }).click();
      expect((await restored).status()).toBe(201);
      await expect(otherHistory.getByText('Version 22', { exact: true })).toBeVisible();
      await expect(otherHistory.getByText('Restored from version 20', { exact: true })).toBeVisible();

      // The former writer keeps its version-21 document when the real renewal is refused.
      const banner = page.getByTestId('studio-save-banner');
      await expect(banner).toHaveAttribute('data-status', 'lease-lost', { timeout: 45_000 });
      await expect(history.getByText('Version 21', { exact: true })).toBeVisible();
      await expect(history.getByRole('button', { name: 'Restore', exact: true })).toHaveCount(0);
      const copied = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/studio/projects' && response.request().method() === 'POST',
      );
      await banner.getByRole('button', { name: 'Save my changes as a copy', exact: true }).click();
      const copyResponse = await copied;
      expect(copyResponse.status()).toBe(201);
      const copy = await copyResponse.json();
      expect(copy.id).not.toBe(project.id);
      await expect(page).toHaveURL(new RegExp(`[?&]project=${copy.id}(?:&|$)`));

      // The copy contains this browser's preserved graph; the other writer's restored head stays intact.
      const [original, savedCopy] = await Promise.all([
        getStudioProject({ id: project.id }, options),
        getStudioProject({ id: copy.id }, options),
      ]);
      expect(original.revision).toBe(22);
      expect(original.envelope?.graph).toEqual(envelope(20).graph);
      expect(savedCopy.revision).toBe(1);
      expect(savedCopy.envelope?.graph).toEqual(envelope(21).graph);
    } finally {
      await otherContext.close();
    }
  });

  test('disposes on sign-out and does not come back without a session', async ({ page, context }) => {
    await page.goto('/studio');
    await expect(page.getByRole('region', { name: 'Studio' })).toBeVisible();
    await context.clearCookies();
    await page.reload();
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});
