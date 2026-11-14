import { expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-1081: the public invoice page (frameleaf-prototype #62, `?screen=photography-invoice`). The server's invoice
 * endpoints are mocked; what is asserted is the amount due now, the hand-off to Stripe checkout and the paid state.
 */

const token = 'b'.repeat(64);
const invoice = {
  studio: { name: 'Cedar & Light', email: 'studio@example.test', color: '#577059' },
  label: 'CL-0042',
  clientName: 'Morgan Ellis',
  lines: [
    { description: 'Portrait session', quantity: 1, unitPrice: 27_500 },
    { description: 'Additional edits', quantity: 2, unitPrice: 3750 },
  ],
  taxBasisPoints: 500,
  currency: 'CAD',
  subtotal: 35_000,
  tax: 1750,
  total: 36_750,
  schedule: [
    { dueOn: '2027-05-22', amount: 10_000 },
    { dueOn: '2027-06-22', amount: 26_750 },
  ],
  paid: 10_000,
  status: 'part',
  next: { amount: 26_750, dueOn: '2027-06-22' },
  payOnline: true,
};

test.describe('invoice page', () => {
  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, '00000000-0000-4000-8000-000000000001');
  });

  test('pays the balance due now through Stripe checkout', async ({ context, page }) => {
    await context.route(`**/api/photography/invoices/view/${token}`, (route) => route.fulfill({ json: invoice }));
    await context.route(`**/api/photography/invoices/view/${token}/checkout`, (route) =>
      route.fulfill({ json: { url: 'https://checkout.stripe.com/c/pay/cs_test_1', paymentId: crypto.randomUUID() } }),
    );
    await context.route('https://checkout.stripe.com/**', (route) => route.fulfill({ body: 'Stripe checkout' }));
    await page.goto(`/photography/invoice/${token}`);
    await expect(page.getByRole('heading', { name: 'Invoice CL-0042' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Deposit paid.');
    await page.getByRole('button', { name: /^Pay / }).click();
    await page.waitForURL('https://checkout.stripe.com/**');
  });

  test('shows a paid invoice without a pay button', async ({ context, page }) => {
    await context.route(`**/api/photography/invoices/view/${token}`, (route) =>
      route.fulfill({ json: { ...invoice, paid: 36_750, status: 'paid', next: null } }),
    );
    await page.goto(`/photography/invoice/${token}`);
    await expect(page.getByRole('heading', { name: 'Invoice paid' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Pay / })).toHaveCount(0);
  });
});
