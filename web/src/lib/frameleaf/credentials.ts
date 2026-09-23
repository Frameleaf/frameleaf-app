/**
 * Write-only server credentials (FL-67): the SMTP password, the OAuth client secret, the RunPod
 * API key and the Hugging Face token.
 *
 * The server never returns these values, only whether each one is stored (`...Configured`).
 * They are replaced or cleared one at a time through `/admin/config/credentials/:name` from a
 * dialog whose value is dropped as soon as it closes, so a credential never sits in a settings
 * draft. This module also makes sure no credential value leaves the browser through a generic
 * configuration path: a save, a copy, an export or an import.
 */

import { ConfigCredential, type AdminConfigDto } from '@immich/sdk';
import { cloneDeep } from 'lodash-es';

export type CredentialDefinition = {
  name: ConfigCredential;
  /** i18n keys for the row and dialog. */
  labelKey: string;
  helpKey: string;
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
  [ConfigCredential.RunpodApiKey]: {
    name: ConfigCredential.RunpodApiKey,
    labelKey: 'frameleaf_credentials_runpod_api_key',
    helpKey: 'frameleaf_credentials_runpod_api_key_help',
  },
  [ConfigCredential.HuggingfaceToken]: {
    name: ConfigCredential.HuggingfaceToken,
    labelKey: 'frameleaf_credentials_huggingface_token',
    helpKey: 'frameleaf_credentials_huggingface_token_help',
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
    case ConfigCredential.RunpodApiKey: {
      return !!config.machineLearning?.runpod?.apiKeyConfigured;
    }
    case ConfigCredential.HuggingfaceToken: {
      return !!config.machineLearning?.runpod?.hfTokenConfigured;
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
  if (copy.machineLearning?.runpod) {
    copy.machineLearning.runpod.apiKey = '';
    copy.machineLearning.runpod.hfToken = '';
  }
  return copy;
};

/** Whether a configuration (for example an imported file) carries any credential value. */
export const hasCredentialValues = (config: PartialConfig): boolean =>
  !!(
    config.notifications?.smtp?.transport?.password ||
    config.oauth?.clientSecret ||
    config.machineLearning?.runpod?.apiKey ||
    config.machineLearning?.runpod?.hfToken
  );

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
    case ConfigCredential.RunpodApiKey: {
      if (next.machineLearning.runpod) {
        next.machineLearning.runpod.apiKeyConfigured = configured;
      }
      break;
    }
    case ConfigCredential.HuggingfaceToken: {
      if (next.machineLearning.runpod) {
        next.machineLearning.runpod.hfTokenConfigured = configured;
      }
      break;
    }
  }
  return next;
};
