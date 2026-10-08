import {
  AssetMediaResponseDto,
  LoginResponseDto,
  createStudioProject,
  getStudioProject,
  releaseStudioProjectLease,
  saveStudioProjectRevision,
} from '@frameleaf/sdk';
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { asBearerAuth, utils } from 'src/utils.js';

/**
 * FL-88 (STU-201): the Studio route against a real server. The vendored engine is not part of
 * this build, so the route must mount its chrome, say plainly that the editor is unavailable and
 * name the missing workers, keep the way back and project review working and leave cleanly.
 * Design: design/frameleaf/template/src/Studio.jsx:2584-2647 (September 24, 2026).
 */
const envelope = (version: number) => ({
  schemaVersion: 1,
  engine: 'freecut',
  engineRevision: '4d62e8082c5eb387a96275bcbd323d28f6e41a62',
  graph: { tracks: [], items: [], fixtureVersion: version },
});

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
    await expect(page.getByTestId('studio-state')).toHaveAttribute('data-phase', 'unavailable');
    // Nothing opened, so the header shows no project controls the unavailable state would contradict.
    await expect(studio.getByText('Editing as', { exact: false })).toHaveCount(0);
    await expect(studio.getByText('All changes saved', { exact: true })).toHaveCount(0);
    await expect(studio.getByRole('textbox', { name: 'Project name' })).toHaveCount(0);
    // No render worker is admitted in the e2e stack; what is missing is listed for whoever runs the server.
    await page.getByText('Details for your administrator', { exact: true }).click();
    await expect(page.getByRole('list', { name: 'Details for your administrator' })).toBeVisible();
    // The editor does not read a Basic or Advanced choice yet, so no switch is offered.
    await expect(page.getByRole('radiogroup', { name: 'Editing mode' })).toHaveCount(0);
  });

  test('goes back to the project list from the header', async ({ page }) => {
    await page.goto('/studio');
    // Both the header and the unavailable state offer the way back; the header's comes first.
    await page
      .getByRole('region', { name: 'Studio' })
      .getByRole('button', { name: 'Projects', exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/studio\/projects/);
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
    await studio.getByRole('button', { name: 'Review', exact: true }).click();
    const history = page.getByRole('complementary', { name: 'Review', exact: true });
    await history.getByRole('radio', { name: 'Versions', exact: true }).click();
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
      const reacquireResponse = await reacquire;
      expect(reacquireResponse.status()).toBe(409);
      await expect(otherBanner).toHaveAttribute('data-status', 'lease-lost');

      await otherBanner.getByRole('button', { name: 'Edit here instead', exact: true }).click();
      await expect(otherBanner).toHaveCount(0);
      await other
        .getByRole('region', { name: 'Studio', exact: true })
        .getByRole('button', { name: 'Review', exact: true })
        .click();
      const otherHistory = other.getByRole('complementary', { name: 'Review', exact: true });
      await otherHistory.getByRole('radio', { name: 'Versions', exact: true }).click();
      const version20 = otherHistory
        .getByRole('listitem')
        .filter({ has: other.getByText('Version 20', { exact: true }) });
      const restored = other.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/studio/projects/${project.id}/restore` &&
          response.request().method() === 'POST',
      );
      await version20.getByRole('button', { name: 'Go back to this version', exact: true }).click();
      const restoredResponse = await restored;
      expect(restoredResponse.status()).toBe(201);
      await expect(otherHistory.getByText('Version 22', { exact: true })).toBeVisible();
      await expect(otherHistory.getByText('Copy of version 20', { exact: true })).toBeVisible();

      // The former writer keeps its version-21 document when the real renewal is refused.
      const banner = page.getByTestId('studio-save-banner');
      await expect(banner).toHaveAttribute('data-status', 'lease-lost', { timeout: 45_000 });
      await expect(history.getByText('Version 21', { exact: true })).toBeVisible();
      await expect(history.getByRole('button', { name: 'Go back to this version', exact: true })).toHaveCount(0);
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

  test('FL-144 a restore whose acknowledgement is lost is applied once, and a reload resumes editing', async ({
    page,
  }) => {
    const options = { headers: asBearerAuth(admin.accessToken) };
    const clientId = randomUUID();
    const project = await createStudioProject(
      {
        studioProjectCreateDto: {
          name: 'Lost acknowledgement',
          clientId,
          requestKey: randomUUID(),
          envelope: envelope(1),
        },
      },
      options,
    );
    for (let revision = 2; revision <= 3; revision++) {
      await saveStudioProjectRevision(
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
    }
    await releaseStudioProjectLease({ id: project.id, studioProjectLeaseRequestDto: { clientId } }, options);

    await page.goto(`/studio?project=${project.id}`);
    const studio = page.getByRole('region', { name: 'Studio', exact: true });
    await studio.getByRole('button', { name: 'Review', exact: true }).click();
    const history = page.getByRole('complementary', { name: 'Review', exact: true });
    await history.getByRole('radio', { name: 'Versions', exact: true }).click();
    await expect(history.locator('ol strong')).toHaveText(['Version 3', 'Version 2', 'Version 1']);

    // The restore reaches the real server and commits; only its response is lost on the way back.
    const restorePath = `/api/studio/projects/${project.id}/restore`;
    let delivered = false;
    await page.route(
      (url) => url.pathname === restorePath,
      async (route) => {
        const response = await route.fetch();
        delivered = response.status() === 201;
        await route.abort('connectionreset');
      },
      { times: 1 },
    );
    await history
      .getByRole('listitem')
      .filter({ has: page.getByText('Version 1', { exact: true }) })
      .getByRole('button', { name: 'Go back to this version', exact: true })
      .click();
    await expect.poll(() => delivered).toBe(true);
    const committed = await getStudioProject({ id: project.id }, options);
    expect(committed.revision).toBe(4);

    // A reload is a new editor instance; the page released its lease on the way out, so it edits
    // again instead of opening behind its own previous lease, and shows the restore exactly once.
    const leasePath = `/api/studio/projects/${project.id}/lease`;
    const reacquired = page.waitForResponse(
      (response) => new URL(response.url()).pathname === leasePath && response.request().method() === 'POST',
    );
    await page.reload();
    // Without the release on unload this is a 409 from the page's own previous instance.
    const reacquiredResponse = await reacquired;
    expect(reacquiredResponse.status()).toBeLessThan(300);
    await expect(page.getByTestId('studio-save-banner')).toHaveCount(0);
    await studio.getByRole('button', { name: 'Review', exact: true }).click();
    await history.getByRole('radio', { name: 'Versions', exact: true }).click();
    await expect(history.locator('ol strong')).toHaveText(['Version 4', 'Version 3', 'Version 2', 'Version 1']);
    await expect(history.getByText('Copy of version 1', { exact: true })).toHaveCount(1);
    const stored = await getStudioProject({ id: project.id }, options);
    expect(stored.revision).toBe(4);
    expect(stored.envelope?.graph).toEqual(envelope(1).graph);
  });

  test('disposes on sign-out and does not come back without a session', async ({ page, context }) => {
    await page.goto('/studio');
    await expect(page.getByRole('region', { name: 'Studio' })).toBeVisible();
    await context.clearCookies();
    await page.reload();
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});
