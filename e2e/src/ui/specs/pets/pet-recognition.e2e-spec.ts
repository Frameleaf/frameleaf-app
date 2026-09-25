import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-58: pet recognition on the Pets page with fake processing destinations (no real worker, no
 * spending). Only the administrator's routed destination is offered: this server, a computer on
 * the network or Frameleaf Cloud; an unavailable worker shows the server's own reason with the
 * way to fix it. A run is durable on the server: it can be stopped, and a reload shows it as the
 * server left it. A named pet's page asks search for that pet's confirmed photos only.
 */
const userId = '00000000-0000-4000-8000-000000000001';
const petId = '00000000-0000-4000-8000-0000000000a1';

const pet = {
  id: petId,
  name: 'Miso',
  species: 'cat',
  birthDate: null,
  featuredAssetId: null,
  isHidden: false,
  isFavorite: false,
  assetCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

type Destination = { kind: 'local' | 'lan' | 'frameleaf-cloud'; name: string } | null;
type Recognition = {
  available: boolean;
  destination: Destination;
  reason: string | null;
  detail: string | null;
  hasConfirmedPhotos: boolean;
  run: Record<string, unknown> | null;
};

const run = (status: string, processedCount: number) => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  status,
  assetCount: 40,
  processedCount,
  proposalCount: 2,
  destinationKind: 'local',
  error: null,
  createdAt: '2026-09-25T10:00:00.000Z',
  finishedAt: status === 'running' ? null : '2026-09-25T10:05:00.000Z',
});

const setup = async (context: BrowserContext, initial: Recognition) => {
  const state = { recognition: initial, calls: [] as string[], searches: [] as unknown[] };
  await context.routeWebSocket('**/socket.io/**', () => {
    // This UI fixture has no authenticated socket session.
  });
  await setupBaseMockApiRoutes(context, userId);
  await context.route('**/api/pets**', async (route, request) => {
    const { pathname } = new URL(request.url());
    if (pathname === '/api/pets/recognition') {
      state.calls.push(request.method());
      if (request.method() === 'POST') {
        state.recognition = { ...state.recognition, run: run('running', 0) };
      } else if (request.method() === 'DELETE') {
        state.recognition = { ...state.recognition, run: run('cancelled', 12) };
      }
      return route.fulfill({ json: state.recognition });
    }
    if (pathname === '/api/pets/candidates') {
      return route.fulfill({
        json: {
          candidates: [],
          recognition: state.recognition,
          recognitionAvailable: state.recognition.available,
          recognitionUnavailableReason: state.recognition.detail,
        },
      });
    }
    if (pathname === `/api/pets/${petId}/observations`) {
      return route.fulfill({ json: [] });
    }
    if (pathname === `/api/pets/${petId}`) {
      return route.fulfill({ json: pet });
    }
    if (pathname === '/api/pets') {
      return route.fulfill({ json: [pet] });
    }
    return route.fallback();
  });
  await context.route('**/api/search/metadata', (route, request) => {
    state.searches.push(request.postDataJSON());
    return route.fulfill({
      json: {
        albums: { count: 0, facets: [], items: [], total: 0 },
        assets: { count: 0, facets: [], items: [], nextCursor: null, nextPage: null, total: 0 },
      },
    });
  });
  await context.route('**/api/jobs/running', (route) =>
    route.fulfill({ json: { operations: [], memoryExports: [], queues: [], canManageQueues: false } }),
  );
  await context.route('**/api/media-operations*', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  return state;
};

const recognitionSection = (page: Page) => page.getByRole('region', { name: 'Recognition' });

const available = (destination: Destination): Recognition => ({
  available: true,
  destination,
  reason: null,
  detail: null,
  hasConfirmedPhotos: true,
  run: null,
});

test.describe('pet recognition', () => {
  test('runs on this server only, can be stopped, and a reload shows the stopped run', async ({ context, page }) => {
    const state = await setup(context, available({ kind: 'local', name: 'This server' }));
    await page.goto('/pets');

    const section = recognitionSection(page);
    await expect(section.getByText('Recognition runs on this server.')).toBeVisible();
    await expect(section.getByText(/Frameleaf Cloud/)).toHaveCount(0);

    await section.getByRole('button', { name: 'Look for pets' }).click();
    await expect(section.getByRole('progressbar', { name: 'Pet recognition progress' })).toBeVisible();
    await expect(section.getByText('Looking through 0 of 40 photos', { exact: false })).toBeVisible();

    await section.getByRole('button', { name: 'Stop looking' }).click();
    await expect(section.getByText('Stopped after 12 of 40 photos.')).toBeVisible();
    expect(state.calls).toEqual(['POST', 'DELETE']);

    // the run lives on the server: a reload shows it as it was left, with no second start
    await page.reload();
    await expect(recognitionSection(page).getByText('Stopped after 12 of 40 photos.')).toBeVisible();
    await expect(recognitionSection(page).getByRole('button', { name: 'Look for pets' })).toBeVisible();
    expect(state.calls).toEqual(['POST', 'DELETE']);
  });

  test('says when recognition runs on Frameleaf Cloud', async ({ context, page }) => {
    await setup(context, available({ kind: 'frameleaf-cloud', name: 'Frameleaf Cloud' }));
    await page.goto('/pets');

    const section = recognitionSection(page);
    await expect(
      section.getByText('Recognition runs on Frameleaf Cloud. Photos are sent there to be checked.'),
    ).toBeVisible();
    await expect(section.getByText('Recognition runs on this server.')).toHaveCount(0);
  });

  test('names a computer on the network', async ({ context, page }) => {
    await setup(context, available({ kind: 'lan', name: 'Studio Mac' }));
    await page.goto('/pets');

    await expect(
      recognitionSection(page).getByText('Recognition runs on Studio Mac, a computer on your network.'),
    ).toBeVisible();
  });

  for (const [reason, sentence] of [
    ['workload-not-served', 'its worker does not offer pet recognition.'],
    ['insufficient-memory', 'its worker does not have enough memory for it.'],
  ] as const) {
    test(`explains an unavailable worker (${reason}) and offers no start`, async ({ context, page }) => {
      await setup(context, {
        available: false,
        destination: null,
        reason,
        detail: sentence,
        hasConfirmedPhotos: true,
        run: null,
      });
      await page.goto('/pets');

      const status = recognitionSection(page).getByTestId('pet-recognition-unavailable');
      await expect(status).toContainText('Recognition is unavailable:');
      await expect(status).toContainText(sentence);
      // the base fixture signs in an administrator, who is sent to the destination settings
      await expect(status.getByRole('link', { name: 'Open processing settings' })).toBeVisible();
      await expect(recognitionSection(page).getByRole('button', { name: 'Look for pets' })).toHaveCount(0);
    });
  }

  test("a named pet's page asks for that pet's confirmed photos", async ({ context, page }) => {
    const state = await setup(context, available({ kind: 'local', name: 'This server' }));
    await page.goto(`/pets/${petId}`);

    await expect(page.getByRole('heading', { name: 'Miso' }).first()).toBeVisible();
    await expect.poll(() => state.searches.length).toBeGreaterThan(0);
    expect(state.searches[0]).toEqual(
      expect.objectContaining({
        filter: expect.objectContaining({ petIds: { any: [petId] }, trashedAt: { eq: null } }),
      }),
    );
  });
});
