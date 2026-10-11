/**
 * The mail providers Email delivery offers (FL-368). A provider is only a preset: choosing one
 * writes the mail server, port and encryption an administrator would otherwise type, and the
 * provider shown is read back from those saved values, so nothing new is stored.
 *
 * Each one needs an "app password" made on the provider's own site.
 *
 * FL-379: Gmail and Microsoft can instead be connected by signing in (`SIGN_IN_PROVIDERS`), with no
 * password at all. Microsoft is offered that way only: it has been turning off password sign-in for
 * mail apps, so it has no preset here.
 */
import { MailSignInProvider, MailTransportType } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';

export type MailProvider = {
  id: string;
  /** The provider's own name, which is not translated. */
  name: string;
  /** Which addresses it covers, under the name on its tile. */
  hint: Translations;
  host: string;
  port: number;
  /** Encrypted from the start of the connection (otherwise it is encrypted once connected). */
  secure: boolean;
  /** The provider's page on making an app password. */
  guide: string;
};

export const MAIL_PROVIDERS: readonly MailProvider[] = Object.freeze([
  {
    id: 'gmail',
    name: 'Gmail',
    hint: 'frameleaf_notify_delivery_hint_gmail',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    guide: 'https://support.google.com/accounts/answer/185833',
  },
  {
    id: 'icloud',
    name: 'iCloud Mail',
    hint: 'frameleaf_notify_delivery_hint_icloud',
    host: 'smtp.mail.me.com',
    port: 587,
    secure: false,
    guide: 'https://support.apple.com/102654',
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    hint: 'frameleaf_notify_delivery_hint_yahoo',
    host: 'smtp.mail.yahoo.com',
    port: 465,
    secure: true,
    guide: 'https://help.yahoo.com/kb/SLN15241.html',
  },
]);

export type SignInProvider = {
  /** The tile it belongs to. */
  id: 'gmail' | 'microsoft';
  provider: MailSignInProvider;
  transport: MailTransportType;
  /** Whose sign-in page opens; a company name, not translated. */
  who: string;
  /** Where a person removes an app's access themselves, when disconnecting cannot do it for them. */
  permissions?: string;
};

/** The providers an account can be connected to by signing in (FL-379). */
export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = Object.freeze([
  { id: 'gmail', provider: MailSignInProvider.Gmail, transport: MailTransportType.Gmail, who: 'Google' },
  {
    id: 'microsoft',
    provider: MailSignInProvider.Microsoft,
    transport: MailTransportType.Microsoft,
    who: 'Microsoft',
    permissions: 'https://account.live.com/consent/Manage',
  },
]);

/** The Microsoft tile: sign-in only, so it is not a preset. */
export const MICROSOFT_TILE = Object.freeze({
  id: 'microsoft',
  name: 'Microsoft',
  hint: 'frameleaf_notify_delivery_hint_microsoft' as Translations,
});

export const signInProviderFor = (id: string | undefined) => SIGN_IN_PROVIDERS.find((item) => item.id === id);

/**
 * The provider the saved values are a preset of: `other` for a mail server that is none of them,
 * and undefined while no mail server has been entered (nothing is chosen yet). A transport that
 * sends through a connected account is that account's provider, whatever mail server is left over.
 */
export const providerOf = (transport: {
  type?: MailTransportType;
  host: string;
  port: number;
  secure: boolean;
}): string | undefined => {
  const signIn = SIGN_IN_PROVIDERS.find((item) => item.transport === transport.type);
  if (signIn) {
    return signIn.id;
  }
  const host = transport.host.trim().toLowerCase();
  if (!host) {
    return undefined;
  }
  return (
    MAIL_PROVIDERS.find(
      (item) => item.host === host && item.port === transport.port && item.secure === transport.secure,
    )?.id ?? 'other'
  );
};
