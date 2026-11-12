import { faker } from '@faker-js/faker';
import { BrowserContext, expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-943: Library care › Things to fix › Dates that look wrong, the Date & Time Doctor, against a mocked server
 * (FL-912's findings, FL-930's preview, apply and undo). A camera's clock was 7 hours ahead for two days of a trip:
 * the page shows one card, previews the fix, applies it, lists it under Recent fixes and undoes it.
 */
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', json: body });
const DAY = 86_400_000;
/** The clock time in Edmonton in August (MDT, UTC−6), as the server sends it. */
const wall = (iso: string) => new Date(Date.parse(iso) - 6 * 3_600_000).toISOString().slice(0, 19);

const drift = (assetId: string, day: string, hour: number) => ({
  assetId,
  cause: 'burst-drift',
  confidence: 0.9,
  currentDate: `${day}T${String(hour + 7).padStart(2, '0')}:40:00.000Z`,
  currentZone: 'America/Edmonton',
  proposedDate: `${day}T${String(hour).padStart(2, '0')}:40:00.000Z`,
  proposedZone: 'America/Edmonton',
});

const setupDateDoctorMocks = async (context: BrowserContext) => {
  const photos = [
    { day: '2026-08-12', finding: drift(faker.string.uuid(), '2026-08-12', 15) },
    { day: '2026-08-14', finding: drift(faker.string.uuid(), '2026-08-14', 16) },
  ];
  const server = { fixed: false, applied: [] as unknown[], undone: [] as string[] };
  const batch = () => ({
    id: 'batch-1',
    cause: 'burst-drift',
    count: 2,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
    shiftMinutes: -420,
    timeZone: null,
    undoneAt: server.undone.length > 0 ? new Date().toISOString() : null,
  });

  await context.route('**/api/date-doctor/findings', (route) =>
    route.fulfill(
      json({
        total: server.fixed ? 0 : photos.length,
        scanning: false,
        groups: server.fixed
          ? []
          : photos.map(({ day, finding }) => ({
              groupKey: `Sony A7 IV|${day}`,
              camera: 'Sony A7 IV',
              day,
              findings: [finding],
            })),
      }),
    ),
  );
  await context.route('**/api/date-doctor/preview', (route) => {
    const { assetIds } = route.request().postDataJSON() as { assetIds: string[] };
    return route.fulfill(
      json({
        items: assetIds.map((assetId) => {
          const { finding } = photos.find((photo) => photo.finding.assetId === assetId)!;
          return {
            assetId,
            before: { date: finding.currentDate, zone: 'America/Edmonton', local: wall(finding.currentDate) },
            after: { date: finding.proposedDate, zone: 'America/Edmonton', local: wall(finding.proposedDate) },
          };
        }),
      }),
    );
  });
  await context.route('**/api/date-doctor/apply', (route) => {
    server.applied.push(route.request().postDataJSON());
    server.fixed = true;
    return route.fulfill({ ...json({ batch: batch(), skipped: [] }), status: 201 });
  });
  await context.route('**/api/date-doctor/batches', (route) =>
    route.fulfill(json(server.applied.length > 0 ? [batch()] : [])),
  );
  await context.route('**/api/date-doctor/batches/*/undo', (route) => {
    server.undone.push(new URL(route.request().url()).pathname.split('/').at(-2)!);
    server.fixed = false;
    return route.fulfill(json(batch()));
  });
  return { server, ids: photos.map(({ finding }) => finding.assetId) };
};

test.describe('Date & Time Doctor (FL-943)', () => {
  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
  });

  test('Things to fix counts the wrong dates and opens the Doctor', async ({ context, page }) => {
    await setupDateDoctorMocks(context);
    await page.goto('/user-settings?area=care&section=repair');

    await expect(page.getByText('2 photos', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Review Dates that look wrong' }).click();
    await expect(page).toHaveURL(/section=dates/);
    await expect(page.getByRole('heading', { name: '2 photos may have the wrong date or time' })).toBeVisible();
  });

  test('previews a fix, applies it, and undoes it from Recent fixes', async ({ context, page }) => {
    const { server, ids } = await setupDateDoctorMocks(context);
    await page.goto('/user-settings?area=care&section=dates');

    const card = page.getByRole('article', { name: /The clock on Sony A7 IV was 7 hours ahead on Aug 12/ });
    await expect(card.getByText('2 photos', { exact: true })).toBeVisible();
    await expect(card.getByText(/Aug 12, 2026, 4:40\sPM MDT/)).toBeVisible();
    await expect(card.getByText(/Aug 12, 2026, 9:40\sAM MDT/)).toBeVisible();

    await card.getByRole('button', { name: 'Fix 2 photos' }).click();
    await expect(
      page.getByText(/2 photos were fixed\. You can undo it under Recent fixes for 30 days\./),
    ).toBeVisible();
    expect(server.applied).toEqual([{ assetIds: ids, useProposal: true }]);
    await expect(page.getByRole('heading', { name: 'Every date looks right' })).toBeVisible();
    await expect(card).toBeHidden();

    const recent = page.getByRole('list', { name: 'Recent fixes' });
    await recent.getByRole('button', { name: 'Undo the fix of 2 photos' }).click();
    await expect(page.getByText('2 photos are back at their old times.')).toBeVisible();
    expect(server.undone).toEqual(['batch-1']);
    await expect(recent.getByText('Undone')).toBeVisible();
    await expect(card).toBeVisible();
  });
});
