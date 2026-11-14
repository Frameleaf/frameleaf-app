import { PhotographyInvoiceCurrency, PhotographyInvoiceStatus } from '@frameleaf/sdk';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PhotographyInvoicePay from './PhotographyInvoicePay.svelte';
import PhotographyInvoices from './PhotographyInvoices.svelte';

const token = 'a'.repeat(64);
const lines = [{ description: 'Portrait session', quantity: 1, unitPrice: 30_000 }];
const publicInvoice = {
  studio: { name: 'Cedar & Light', email: 'studio@example.test', color: '#577059' },
  label: 'CL-0042',
  clientName: 'Morgan Ellis',
  lines,
  taxBasisPoints: 500,
  currency: 'CAD',
  subtotal: 30_000,
  tax: 1500,
  total: 31_500,
  schedule: [
    { dueOn: '2027-05-22', amount: 10_000 },
    { dueOn: '2027-06-22', amount: 21_500 },
  ],
  paid: 0,
  status: PhotographyInvoiceStatus.Sent,
  next: { amount: 10_000, dueOn: '2027-05-22' },
  payOnline: true,
};
const invoice = {
  ...publicInvoice,
  id: '00000000-0000-4000-8000-000000000001',
  number: 42,
  clientEmail: 'morgan@example.test',
  reminders: true,
  overdue: false,
  sentAt: null,
  createdAt: '2027-01-01T00:00:00.000Z',
};

beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  vi.clearAllMocks();
  sdkMock.isHttpError.mockImplementation((error) => typeof (error as { status?: number })?.status === 'number');
});

it('shows the amount due now and pays only through Stripe checkout', async () => {
  sdkMock.photographyPublicInvoice.mockResolvedValue(publicInvoice);
  sdkMock.photographyInvoiceCheckout.mockResolvedValue({ url: 'https://evil.example/pay', paymentId: invoice.id });
  render(PhotographyInvoicePay, { token, paymentId: null });
  expect(await screen.findByRole('heading', { name: 'Invoice CL-0042' })).toBeInTheDocument();
  expect(screen.getByText('Prepared for Morgan Ellis')).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: /^Pay / }));
  expect(await screen.findByText('The payment didn’t go through. Try again.')).toBeInTheDocument();
  expect(sdkMock.photographyInvoiceCheckout).toHaveBeenCalledWith({ token });
});

it('says when an invoice is paid, and when its link no longer works', async () => {
  sdkMock.photographyPublicInvoice.mockResolvedValueOnce({ ...publicInvoice, paid: 31_500, next: null });
  const { unmount } = render(PhotographyInvoicePay, { token, paymentId: null });
  expect(await screen.findByText('Invoice paid')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument();
  unmount();
  sdkMock.photographyPublicInvoice.mockRejectedValueOnce({ status: 404 });
  render(PhotographyInvoicePay, { token, paymentId: null });
  expect(await screen.findByText('This invoice link is unavailable')).toBeInTheDocument();
});

it('saves an invoice in minor units and records a manual payment', async () => {
  sdkMock.photographyInvoices.mockResolvedValue({ items: [invoice], mailReady: true, paymentsReady: true });
  sdkMock.photographyCreateInvoice.mockResolvedValue(invoice);
  sdkMock.photographyMarkInvoicePaid.mockResolvedValue(invoice);
  render(PhotographyInvoices);
  await fireEvent.click(await screen.findByRole('button', { name: 'New invoice' }));
  await fireEvent.input(screen.getByLabelText('Client'), { target: { value: 'Morgan' } });
  await fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'morgan@example.test' } });
  await fireEvent.input(screen.getByLabelText('Description'), { target: { value: 'Session' } });
  await fireEvent.input(screen.getByLabelText('Unit price (CAD)'), { target: { value: '275.50' } });
  await fireEvent.input(screen.getByLabelText('Balance due'), { target: { value: '2027-06-22' } });
  await fireEvent.submit(screen.getByLabelText('Client').closest('form')!);
  await waitFor(() =>
    expect(sdkMock.photographyCreateInvoice).toHaveBeenCalledWith({
      photographyInvoiceSaveDto: expect.objectContaining({
        currency: PhotographyInvoiceCurrency.Cad,
        lines: [{ description: 'Session', quantity: 1, unitPrice: 27_550 }],
        deposit: 0,
        depositDue: null,
        balanceDue: '2027-06-22',
      }),
    }),
  );
  expect(sdkMock.photographySendInvoice).not.toHaveBeenCalled();
  await fireEvent.click(await screen.findByRole('button', { name: 'Mark as paid' }));
  await fireEvent.input(screen.getByLabelText('Amount (CAD)'), { target: { value: '100' } });
  await fireEvent.submit(screen.getByLabelText('Amount (CAD)').closest('form')!);
  await waitFor(() =>
    expect(sdkMock.photographyMarkInvoicePaid).toHaveBeenCalledWith({
      id: invoice.id,
      photographyInvoicePaidDto: { amount: 10_000 },
    }),
  );
});
