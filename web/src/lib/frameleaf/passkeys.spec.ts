import { ceremonyProblem, cleanName, passkeysHere, serverCode } from '$lib/frameleaf/passkeys';

describe('passkeys (FL-859)', () => {
  it('works only on https or localhost, in a browser that has passkeys', () => {
    expect(passkeysHere({ protocol: 'https:', hostname: 'photos.example.com', webAuthn: true })).toEqual({ ok: true });
    expect(passkeysHere({ protocol: 'http:', hostname: 'localhost', webAuthn: true })).toEqual({ ok: true });
    expect(passkeysHere({ protocol: 'http:', hostname: '192.168.1.20', webAuthn: true })).toEqual({
      ok: false,
      reason: 'http',
    });
    expect(passkeysHere({ protocol: 'https:', hostname: 'photos.example.com', webAuthn: false })).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('treats a cancelled window as no error, and tells an existing passkey apart', () => {
    expect(ceremonyProblem({ name: 'NotAllowedError' })).toBe('cancelled');
    expect(ceremonyProblem({ code: 'ERROR_CEREMONY_ABORTED' })).toBe('cancelled');
    expect(ceremonyProblem({ code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' })).toBe('exists');
    expect(ceremonyProblem(new Error('boom'))).toBe('failed');
  });

  it('tidies names and reads the server’s code', () => {
    expect(cleanName('  Work   laptop')).toBe('Work laptop');
    expect(cleanName('x'.repeat(50))).toHaveLength(40);
    expect(serverCode({ data: { code: 'passkey_expired' } })).toBe('passkey_expired');
    expect(serverCode({ data: '{"code":"passkey_failed"}' })).toBe('passkey_failed');
    expect(serverCode(new Error('x'))).toBeUndefined();
  });
});
