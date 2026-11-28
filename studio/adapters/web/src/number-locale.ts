/**
 * Numbers in the host's format (FL-1822). The host sends the person's "Dates and numbers" choice,
 * which may differ from the interface language; absent means the device's format.
 */
import { setNumberLocale } from '@/i18n';
import type { StudioHostContext } from '@frameleaf/host/host-contract';

export function applyNumberLocale(
  context: Pick<StudioHostContext, 'auth'>,
): void {
  setNumberLocale(context.auth.numberLocale);
}
