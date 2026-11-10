import { describe, expect, it } from 'vitest';
import { redactPrivateLog } from 'src/utils/private-log-redaction.js';

describe(redactPrivateLog.name, () => {
  it.each([
    ['Authorization: Bearer a-private-bearer', 'a-private-bearer'],
    ['Cookie: session=private-cookie; other=another-private-cookie', 'another-private-cookie'],
    ['"refresh_token": "private-refresh-value"', 'private-refresh-value'],
    ['password="password with spaces"', 'password with spaces'],
    ['s3SecretAccessKey=secret-credential', 'secret-credential'],
    ['privateKey: -----BEGIN PRIVATE KEY-----\nreally-private-key\n-----END PRIVATE KEY-----', 'really-private-key'],
    ['https://example.org/s3?X-Amz-Credential=private-url&other=also-private', 'also-private'],
    ['Failed login for somebody@example.org', 'somebody@example.org'],
  ])('redacts secrets from %s', (message, secret) => {
    expect(redactPrivateLog(message)).toContain('[redacted]');
    expect(redactPrivateLog(message)).not.toContain(secret);
  });

  it('keeps operational context', () => {
    expect(redactPrivateLog('Thumbnail queue worker started on port 8080')).toBe(
      'Thumbnail queue worker started on port 8080',
    );
  });
});
