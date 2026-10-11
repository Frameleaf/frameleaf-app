/**
 * The mail providers Email delivery offers (FL-368). A provider is only a preset: choosing one
 * writes the mail server, port and encryption an administrator would otherwise type, and the
 * provider shown is read back from those saved values, so nothing new is stored.
 *
 * Each one needs an "app password" made on the provider's own site. Outlook.com is not offered:
 * it must be tested before it ships, because Microsoft has been turning off password sign-in for
 * mail apps on personal accounts.
 */
export type MailProvider = {
  id: string;
  /** The provider's own name, which is not translated. */
  name: string;
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
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    guide: 'https://support.google.com/accounts/answer/185833',
  },
  {
    id: 'icloud',
    name: 'iCloud Mail',
    host: 'smtp.mail.me.com',
    port: 587,
    secure: false,
    guide: 'https://support.apple.com/102654',
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    host: 'smtp.mail.yahoo.com',
    port: 465,
    secure: true,
    guide: 'https://help.yahoo.com/kb/SLN15241.html',
  },
]);

/**
 * The provider the saved values are a preset of: `other` for a mail server that is none of them,
 * and undefined while no mail server has been entered (nothing is chosen yet).
 */
export const providerOf = (transport: { host: string; port: number; secure: boolean }): string | undefined => {
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
