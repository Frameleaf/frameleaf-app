import { createHmac } from 'node:crypto';
import {
  CAST_MEDIA_TTL_MS,
  CastMediaClaims,
  CastMediaKind,
  castMediaPath,
  signCastMediaToken,
  verifyCastMediaToken,
} from 'src/utils/cast-media.js';

const mac = (payload: string) =>
  Promise.resolve(createHmac('sha256', 'server-secret').update(payload).digest('base64url'));
const otherServer = (payload: string) =>
  Promise.resolve(createHmac('sha256', 'another-secret').update(payload).digest('base64url'));

const NOW = Date.UTC(2026, 9, 9, 12);
const claims = (overrides: Partial<CastMediaClaims> = {}): CastMediaClaims => ({
  v: 1,
  a: '11111111-1111-4111-8111-111111111111',
  u: '22222222-2222-4222-8222-222222222222',
  s: '33333333-3333-4333-8333-333333333333',
  k: null,
  m: CastMediaKind.Video,
  e: NOW + CAST_MEDIA_TTL_MS,
  ...overrides,
});

describe('Cast media URLs', () => {
  it('round-trips a signed token and never carries a session token', async () => {
    const token = await signCastMediaToken(claims(), mac);
    await expect(verifyCastMediaToken(token, mac, NOW)).resolves.toEqual(claims());
    expect(castMediaPath(token)).toBe(`/api/cast/${token}`);
    const decoded = Buffer.from(token.split('.', 1)[0], 'base64url').toString();
    expect(Object.keys(JSON.parse(decoded)).toSorted()).toEqual(['a', 'e', 'k', 'm', 's', 'u', 'v']);
  });

  it('expires after 15 minutes', async () => {
    const token = await signCastMediaToken(claims(), mac);
    await expect(verifyCastMediaToken(token, mac, NOW + CAST_MEDIA_TTL_MS - 1)).resolves.not.toBeNull();
    await expect(verifyCastMediaToken(token, mac, NOW + CAST_MEDIA_TTL_MS)).resolves.toBeNull();
  });

  it('refuses a tampered item, rendition or expiry, a foreign signature and malformed tokens', async () => {
    const token = await signCastMediaToken(claims(), mac);
    const [, signature] = token.split('.', 2);
    const forge = (changes: Partial<CastMediaClaims>) =>
      `${Buffer.from(JSON.stringify(claims(changes))).toString('base64url')}.${signature}`;

    await expect(
      verifyCastMediaToken(forge({ a: '44444444-4444-4444-8444-444444444444' }), mac, NOW),
    ).resolves.toBeNull();
    await expect(verifyCastMediaToken(forge({ m: CastMediaKind.Original }), mac, NOW)).resolves.toBeNull();
    await expect(verifyCastMediaToken(forge({ e: NOW + 86_400_000 }), mac, NOW)).resolves.toBeNull();
    await expect(verifyCastMediaToken(token, otherServer, NOW)).resolves.toBeNull();
    await expect(verifyCastMediaToken(`${token}x`, mac, NOW)).resolves.toBeNull();
    await expect(verifyCastMediaToken(`${token}.extra`, mac, NOW)).resolves.toBeNull();
    await expect(verifyCastMediaToken('not-a-token', mac, NOW)).resolves.toBeNull();
    await expect(verifyCastMediaToken('a'.repeat(2000), mac, NOW)).resolves.toBeNull();

    // a correctly signed payload that is not a claim set
    const junk = Buffer.from('{"v":2}').toString('base64url');
    await expect(verifyCastMediaToken(`${junk}.${await mac(junk)}`, mac, NOW)).resolves.toBeNull();
  });
});
