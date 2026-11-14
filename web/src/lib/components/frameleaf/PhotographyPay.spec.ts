import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PhotographyPay from './PhotographyPay.svelte';

const link = {
  title: 'Mini-session deposit',
  description: 'Goes toward your session.',
  amount: 15_000,
  currency: 'CAD',
  brand: { name: 'Cedar & Light', email: 'hi@cedar.test', color: '#335544', logoInitials: 'CL' },
};
const slug = 'AbCdEfGhIjKlMnOp';
beforeAll(() => addMessages('dev', en));

describe('PhotographyPay', () => {
  it('shows the amount the studio set and asks for a receipt address', async () => {
    sdkMock.photographyPublicPaymentLink.mockResolvedValue(link);
    render(PhotographyPay, { slug, paymentId: null });
    expect(await screen.findByRole('heading', { name: 'Mini-session deposit' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email for your receipt')).toBeRequired();
    expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeInTheDocument();
  });

  it('says an unavailable link is unavailable without naming the studio', async () => {
    sdkMock.photographyPublicPaymentLink.mockRejectedValue(new Error('404'));
    render(PhotographyPay, { slug, paymentId: null });
    expect(await screen.findByText('This payment link is unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/Cedar/)).not.toBeInTheDocument();
  });

  it('thanks the payer once the studio’s server has the payment', async () => {
    sdkMock.photographyPublicPaymentLink.mockRejectedValue(new Error('closed single-use link'));
    sdkMock.photographyPayStatus.mockResolvedValue({ status: 'paid', amount: 15_000, currency: 'CAD' } as never);
    render(PhotographyPay, { slug, paymentId: '00000000-0000-4000-8000-000000000009' });
    expect(await screen.findByText('Thank you for your payment')).toBeInTheDocument();
  });

  it('tells the payer a refunded payment was refunded, not that it failed', async () => {
    sdkMock.photographyPublicPaymentLink.mockResolvedValue(link);
    sdkMock.photographyPayStatus.mockResolvedValue({ status: 'refunded', amount: 15_000, currency: 'CAD' } as never);
    render(PhotographyPay, { slug, paymentId: '00000000-0000-4000-8000-000000000009' });
    expect(await screen.findByText('This payment was refunded')).toBeInTheDocument();
    expect(screen.queryByText(/didn’t go through/)).not.toBeInTheDocument();
  });
});
