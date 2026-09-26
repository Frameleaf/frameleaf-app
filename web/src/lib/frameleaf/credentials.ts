/**
 * Write-only server credentials (FL-67): the SMTP password and the OAuth client secret. Sign in with
 * Frameleaf has no client secret (FL-177): it authenticates with this server's key.
 *
 * The server never returns these values, only whether each one is stored (`...Configured`).
 * They are replaced or cleared one at a time through `/admin/config/credentials/:name` from a
 * dialog whose value is dropped as soon as it closes, so a credential never sits in a settings
 * draft. This module also makes sure no credential value leaves the browser through a generic
 * configuration path: a save, a copy, an export or an import.
 */
import { ConfigCredential, type AdminConfigDto } from '@immich/sdk';
import { cloneDeep } from 'lodash-es';
import type { Translations } from 'svelte-i18n';

export type CredentialDefinition = {
  name: ConfigCredential;
  /** i18n keys for the row and dialog. */
  labelKey: Translations;
  helpKey: Translations;
};

/** Labels and help follow the design template's `credentials` entries in its settings catalog. */
export const CREDENTIALS: Record<ConfigCredential, CredentialDefinition> = {
  [ConfigCredential.SmtpPassword]: {
    name: ConfigCredential.SmtpPassword,
    labelKey: 'frameleaf_credentials_smtp_password',
    helpKey: 'frameleaf_credentials_smtp_password_help',
  },
  [ConfigCredential.OauthClientSecret]: {
    name: ConfigCredential.OauthClientSecret,
    labelKey: 'frameleaf_credentials_oauth_client_secret',
    helpKey: 'frameleaf_credentials_oauth_client_secret_help',
  },
};

/** The same limit the server applies. */
export const CREDENTIAL_MAX_LENGTH = 4096;

/** A value the server will accept: not blank and within the limit. The value is sent as typed. */
export const isCredentialValueValid = (value: string) =>
  value.trim().length > 0 && value.length <= CREDENTIAL_MAX_LENGTH;

type PartialConfig = Partial<AdminConfigDto>;

/** Whether the configuration says the credential is stored. */
export const isCredentialConfigured = (config: PartialConfig, name: ConfigCredential): boolean => {
  switch (name) {
    case ConfigCredential.SmtpPassword: {
      return !!config.notifications?.smtp?.transport?.passwordConfigured;
    }
    case ConfigCredential.OauthClientSecret: {
      return !!config.oauth?.clientSecretConfigured;
    }
  }
};

/**
 * A copy of the configuration with every credential value emptied and the `...Configured` flags
 * kept. The server reads an empty credential as "keep the stored one", so this is safe to send
 * back, to copy and to export: it can never set, change or leak a credential.
 */
export const withoutCredentialValues = <T extends PartialConfig>(config: T): T => {
  const copy = cloneDeep(config);
  if (copy.notifications?.smtp?.transport) {
    copy.notifications.smtp.transport.password = '';
  }
  if (copy.oauth) {
    copy.oauth.clientSecret = '';
  }
  return copy;
};

/**
 * A copy with every credential value emptied and the read-only `...Configured` flags removed: what
 * a generic save sends and compares. A form's draft keeps the flags it was loaded with, so without
 * this a section whose credential was replaced meanwhile would always look changed.
 */
export const forConfigSave = <T extends PartialConfig>(config: T): T => {
  const copy = withoutCredentialValues(config);
  delete copy.notifications?.smtp?.transport?.passwordConfigured;
  delete copy.oauth?.clientSecretConfigured;
  return copy;
};

/** Whether a configuration (for example an imported file) carries any credential value. */
export const hasCredentialValues = (config: PartialConfig): boolean =>
  !!(config.notifications?.smtp?.transport?.password || config.oauth?.clientSecret);

/**
 * The configuration after a credential change, for the shared settings state: the flag follows
 * the server's answer and the value stays empty.
 */
export const withCredentialState = (
  config: AdminConfigDto,
  name: ConfigCredential,
  configured: boolean,
): AdminConfigDto => {
  const next = withoutCredentialValues(config);
  switch (name) {
    case ConfigCredential.SmtpPassword: {
      next.notifications.smtp.transport.passwordConfigured = configured;
      break;
    }
    case ConfigCredential.OauthClientSecret: {
      next.oauth.clientSecretConfigured = configured;
      break;
    }
  }
  return next;
};
