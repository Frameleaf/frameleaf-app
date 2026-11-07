import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  matchTotp,
  newRecoveryCodes,
  otpauthUri,
  signToken,
  totpCode,
  totpStep,
  verifyToken,
} from 'src/utils/two-factor.js';

// RFC 6238 appendix B: the SHA-1 seed "12345678901234567890"; its 8-digit codes end in these 6 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const mac = (value: string) => Promise.resolve(`mac(${value})`);

describe('two-factor', () => {
  it('round-trips base32', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it.each([
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_234_567_890, '005924'],
    [20_000_000_000, '353130'],
  ])('matches the RFC 6238 vector at %i', (seconds, code) => {
    expect(totpCode(RFC_SECRET, totpStep(new Date(seconds * 1000)))).toBe(code);
  });

  it('accepts one step of drift either way and nothing further', () => {
    const now = new Date(1_234_567_890 * 1000);
    const step = totpStep(now);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now)).toBeNull();
    expect(matchTotp(RFC_SECRET, '12345', now)).toBeNull();
    expect(matchTotp(RFC_SECRET, 'abcdef', now)).toBeNull();
  });

  it('makes ten distinct recovery codes whose hash ignores case and dashes', () => {
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(hashRecoveryCode(codes[0].toUpperCase().replace('-', ''))).toEqual(hashRecoveryCode(codes[0]));
  });

  it('builds an otpauth address apps read', () => {
    expect(otpauthUri('Frameleaf', 'a@b.c', 'ABC')).toBe(
      'otpauth://totp/Frameleaf%3Aa%40b.c?secret=ABC&issuer=Frameleaf&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('verifies a token only with its binding and before it expires', async () => {
    const now = new Date('2026-11-07T00:00:00Z');
    const token = await signToken(mac, { sub: 'u1', exp: now.getTime() / 1000 + 60 }, 'hash-1');
    await expect(verifyToken(mac, token, 'hash-1', now)).resolves.toMatchObject({ sub: 'u1' });
    await expect(verifyToken(mac, token, 'hash-2', now)).resolves.toBeNull();
    await expect(verifyToken(mac, token, 'hash-1', new Date(now.getTime() + 61_000))).resolves.toBeNull();
    const [, signature] = token.split('.', 2);
    const forged = `${Buffer.from(JSON.stringify({ sub: 'u2', exp: 9e9 })).toString('base64url')}.${signature}`;
    await expect(verifyToken(mac, forged, 'hash-1', now)).resolves.toBeNull();
  });
});
