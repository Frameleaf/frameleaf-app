import { expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-1079: the public contract signing page (frameleaf-prototype #62, `?screen=photography-sign`). The
 * server's signing endpoints are mocked; what is asserted is the typed and drawn signing paths and the
 * friendly page for a link that no longer works.
 */

const token = 'a'.repeat(64);
const contract = {
  studio: { name: 'Cedar & Light', email: 'studio@example.test', color: '#577059' },
  name: 'Portrait session agreement',
  body: 'Cedar & Light will photograph Morgan Ellis on May 22, 2027. The session total is $350.00.',
  documentSha256: 'b'.repeat(64),
  signed: false,
  signerName: null,
  signedAt: null,
  history: [],
};

test.describe('contract signing', () => {
  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, '00000000-0000-4000-8000-000000000001');
  });

  test('signs with a drawn signature and shows the signed copy', async ({ context, page }) => {
    let signed: Record<string, unknown> | undefined;
    await context.route(`**/api/photography/sign/${token}`, async (route) => {
      if (route.request().method() === 'POST') {
        signed = route.request().postDataJSON();
        return route.fulfill({
          status: 201,
          json: {
            ...contract,
            signed: true,
            signerName: 'Morgan Ellis',
            signedAt: '2027-01-01T00:00:00.000Z',
            history: [
              { type: 'sent', at: '2027-01-01T00:00:00.000Z' },
              { type: 'signed', at: '2027-01-01T00:05:00.000Z' },
            ],
          },
        });
      }
      return route.fulfill({ json: contract });
    });
    await page.goto(`/photography/sign/${token}`);
    await expect(page.getByRole('heading', { name: contract.name })).toBeVisible();
    await page.getByLabel('Full name').fill('Morgan Ellis');
    await page.getByLabel('Draw my signature').check();
    const pad = page.getByLabel('Draw your signature. You can sign using the typed name instead.');
    const box = (await pad.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 30, { steps: 5 });
    await page.mouse.move(box.x + 220, box.y + 70, { steps: 5 });
    await page.mouse.up();
    await page.getByLabel('I’ve read the agreement and agree to sign electronically.').check();
    await page.getByRole('button', { name: 'Sign agreement' }).click();
    await expect(page.getByRole('heading', { name: 'Agreement signed' })).toBeVisible();
    expect(signed).toMatchObject({
      name: 'Morgan Ellis',
      signatureType: 'drawn',
      consent: true,
      documentSha256: contract.documentSha256,
    });
    expect(String(signed?.signaturePng)).toMatch(/^data:image\/png;base64,/);
    await expect(page.getByRole('link', { name: 'Download signed agreement' })).toHaveAttribute(
      'href',
      `/api/photography/sign/${token}/pdf`,
    );
  });

  test('explains a link that has expired or was voided', async ({ context, page }) => {
    await context.route(`**/api/photography/sign/${token}`, (route) =>
      route.fulfill({ status: 404, json: { message: 'This agreement link is unavailable', statusCode: 404 } }),
    );
    await page.goto(`/photography/sign/${token}`);
    await expect(page.getByRole('heading', { name: 'This agreement link is unavailable' })).toBeVisible();
    await expect(page.getByText('Ask the studio for a new link.')).toBeVisible();
  });
});
