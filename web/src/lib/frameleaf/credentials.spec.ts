import { describe, expect, it } from 'vitest';
import {
  CREDENTIALS,
  hasCredentialValues,
  isCredentialConfigured,
  isCredentialValueValid,
  withCredentialState,
  withoutCredentialValues,
} from '$lib/frameleaf/credentials';
import { ConfigCredential, type AdminConfigDto } from '@immich/sdk';

const config = (): AdminConfigDto =>
  ({
    notifications: {
      smtp: {
        enabled: true,
        from: 'photos@example.com',
        replyTo: '',
        transport: {
          host: 'mail.example.com',
          ignoreCert: false,
          password: 'smtp-secret',
          passwordConfigured: true,
          port: 587,
          secure: true,
          username: 'photos',
        },
      },
    },
    oauth: { clientId: 'frameleaf', clientSecret: 'oauth-secret', clientSecretConfigured: true },
    machineLearning: {
      enabled: true,
      runpod: { apiKey: 'rp-secret', apiKeyConfigured: true, hfToken: 'hf-secret', hfTokenConfigured: false },
    },
    trash: { enabled: true, days: 30 },
  }) as unknown as AdminConfigDto;

describe('write-only credentials (FL-67)', () => {
  it('names every credential the server accepts', () => {
    expect(Object.keys(CREDENTIALS).sort()).toEqual([...Object.values(ConfigCredential)].sort());
  });

  it('empties every credential value and keeps everything else, without touching the original', () => {
    const original = config();
    const safe = withoutCredentialValues(original);

    expect(safe.notifications.smtp.transport.password).toBe('');
    expect(safe.oauth.clientSecret).toBe('');
    expect(safe.machineLearning.runpod?.apiKey).toBe('');
    expect(safe.machineLearning.runpod?.hfToken).toBe('');
    expect(safe.notifications.smtp.transport.passwordConfigured).toBe(true);
    expect(safe.notifications.smtp.transport.host).toBe('mail.example.com');
    expect(safe.trash).toEqual(original.trash);
    expect(JSON.stringify(safe)).not.toMatch(/smtp-secret|oauth-secret|rp-secret|hf-secret/);
    expect(original.oauth.clientSecret).toBe('oauth-secret');
  });

  it('empties values in a partial configuration such as one settings form', () => {
    const { oauth } = withoutCredentialValues({ oauth: config().oauth });
    expect(oauth?.clientSecret).toBe('');
    expect(withoutCredentialValues({ trash: { enabled: false, days: 1 } })).toEqual({
      trash: { enabled: false, days: 1 },
    });
  });

  it('tells whether an imported configuration carries a credential', () => {
    expect(hasCredentialValues(config())).toBe(true);
    expect(hasCredentialValues(withoutCredentialValues(config()))).toBe(false);
    expect(hasCredentialValues({})).toBe(false);
  });

  it('reads whether each credential is stored from its flag', () => {
    const current = config();
    expect(isCredentialConfigured(current, ConfigCredential.SmtpPassword)).toBe(true);
    expect(isCredentialConfigured(current, ConfigCredential.OauthClientSecret)).toBe(true);
    expect(isCredentialConfigured(current, ConfigCredential.RunpodApiKey)).toBe(true);
    expect(isCredentialConfigured(current, ConfigCredential.HuggingfaceToken)).toBe(false);
    expect(isCredentialConfigured({}, ConfigCredential.SmtpPassword)).toBe(false);
  });

  it('follows the server answer after a change and never keeps a value', () => {
    const cleared = withCredentialState(config(), ConfigCredential.SmtpPassword, false);
    expect(cleared.notifications.smtp.transport).toMatchObject({ password: '', passwordConfigured: false });

    const stored = withCredentialState(config(), ConfigCredential.HuggingfaceToken, true);
    expect(stored.machineLearning.runpod).toMatchObject({ hfToken: '', hfTokenConfigured: true });
    expect(JSON.stringify(stored)).not.toMatch(/-secret/);
  });

  it('accepts any non-blank value up to the server limit, as typed', () => {
    expect(isCredentialValueValid('  spaced secret  ')).toBe(true);
    expect(isCredentialValueValid('')).toBe(false);
    expect(isCredentialValueValid('   ')).toBe(false);
    expect(isCredentialValueValid('x'.repeat(4096))).toBe(true);
    expect(isCredentialValueValid('x'.repeat(4097))).toBe(false);
  });
});
