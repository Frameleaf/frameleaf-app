import type { ClientsPaymentAccountDto } from '@frameleaf/sdk';

export type PaymentsView = 'loading' | 'error' | 'unavailable' | 'empty' | 'connecting' | 'connected' | 'attention';

/** FL-1037, FL-1000 mock states: connected once Stripe enables charges; attention while Stripe still needs details. */
export const paymentsView = (
  // The SDK's status is a generated enum; its values are plain strings.
  account: Pick<ClientsPaymentAccountDto, 'chargesEnabled' | 'requirementsDue'> & { status: string },
): PaymentsView => {
  if (account.status === 'unavailable') {
    return 'unavailable';
  }
  if (account.status === 'none' || account.status === 'disconnected') {
    return 'empty';
  }
  if (account.status === 'active' && account.chargesEnabled) {
    return 'connected';
  }
  return account.requirementsDue.length > 0 ? 'attention' : 'connecting';
};
