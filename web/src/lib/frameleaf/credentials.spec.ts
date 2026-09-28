import { ConfigCredential, type AdminConfigDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIALS,
  forConfigSave,
  hasCredentialValues,
  isCredentialConfigured,
  isCredentialValueValid,
  withCredentialState,
  withoutCredentialValues,
} from '$lib/frameleaf/credentials';

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
    machineLearning: { enabled: true, urls: ['http://ml:3003'] },
    trash: { enabled: true, days: 30 },
  }) as unknown as AdminConfigDto;

describe('write-only credentials (FL-67)', () => {
  it('names every credential the server accepts', () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect(Object.keys(CREDENTIALS).sort(byName)).toEqual(Object.values(ConfigCredential).sort(byName));
  });

  it('empties every credential value and keeps everything else, without touching the original', () => {
    const original = config();
    const safe = withoutCredentialValues(original);

    expect(safe.notifications.smtp.transport.password).toBe('');
    expect(safe.oauth.clientSecret).toBe('');
    expect(safe.machineLearning).toEqual(original.machineLearning);
    expect(safe.notifications.smtp.transport.passwordConfigured).toBe(true);
    expect(safe.notifications.smtp.transport.host).toBe('mail.example.com');
    expect(safe.trash).toEqual(original.trash);
    expect(JSON.stringify(safe)).not.toMatch(/smtp-secret|oauth-secret/);
    expect(original.oauth.clientSecret).toBe('oauth-secret');
  });

  it('empties values in a partial configuration such as one settings form', () => {
    const { oauth } = withoutCredentialValues({ oauth: config().oauth });
    expect(oauth?.clientSecret).toBe('');
    expect(withoutCredentialValues({ trash: { enabled: false, days: 1 } })).toEqual({
      trash: { enabled: false, days: 1 },
    });
  });

  it('leaves values and the read-only flags out of what a generic save sends and compares', () => {
    const saved = forConfigSave(config());
    expect(saved.notifications.smtp.transport).not.toHaveProperty('passwordConfigured');
    expect(saved.oauth).not.toHaveProperty('clientSecretConfigured');
    expect(saved.oauth.clientSecret).toBe('');

    // a draft loaded before a credential was replaced compares equal to the fresh configuration
    const stale = withCredentialState(config(), ConfigCredential.SmtpPassword, false);
    expect(forConfigSave(stale)).toEqual(forConfigSave(config()));
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
    expect(
      isCredentialConfigured(
        withCredentialState(current, ConfigCredential.OauthClientSecret, false),
        ConfigCredential.OauthClientSecret,
      ),
    ).toBe(false);
    expect(isCredentialConfigured({}, ConfigCredential.SmtpPassword)).toBe(false);
  });

  it('follows the server answer after a change and never keeps a value', () => {
    const cleared = withCredentialState(config(), ConfigCredential.SmtpPassword, false);
    expect(cleared.notifications.smtp.transport).toMatchObject({ password: '', passwordConfigured: false });

    const stored = withCredentialState(config(), ConfigCredential.OauthClientSecret, true);
    expect(stored.oauth).toMatchObject({ clientSecret: '', clientSecretConfigured: true });
    expect(JSON.stringify(stored)).not.toMatch(/-secret/);
  });

  it('treats the cloud backup secret access key like every other credential (FL-160)', () => {
    const withBackup = {
      ...config(),
      frameleafCloud: {
        cloudBackup: {
          s3: { endpoint: 'https://s3.example.test', secretAccessKey: 's3-secret', secretAccessKeyConfigured: true },
        },
      },
    } as unknown as AdminConfigDto;

    expect(hasCredentialValues({ frameleafCloud: withBackup.frameleafCloud })).toBe(true);
    const safe = withoutCredentialValues(withBackup);
    expect(safe.frameleafCloud?.cloudBackup?.s3).toMatchObject({
      secretAccessKey: '',
      secretAccessKeyConfigured: true,
    });
    expect(forConfigSave(withBackup).frameleafCloud?.cloudBackup?.s3).not.toHaveProperty('secretAccessKeyConfigured');
    expect(isCredentialConfigured(withBackup, ConfigCredential.CloudBackupS3SecretKey)).toBe(true);
    const cleared = withCredentialState(withBackup, ConfigCredential.CloudBackupS3SecretKey, false);
    expect(isCredentialConfigured(cleared, ConfigCredential.CloudBackupS3SecretKey)).toBe(false);
    expect(JSON.stringify(cleared)).not.toContain('s3-secret');
  });

  it('accepts any non-blank value up to the server limit, as typed', () => {
    expect(isCredentialValueValid('  spaced secret  ')).toBe(true);
    expect(isCredentialValueValid('')).toBe(false);
    expect(isCredentialValueValid(' '.repeat(3))).toBe(false);
    expect(isCredentialValueValid('x'.repeat(4096))).toBe(true);
    expect(isCredentialValueValid('x'.repeat(4097))).toBe(false);
  });
});
