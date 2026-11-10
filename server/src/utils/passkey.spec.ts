import {
  answeredChallenge,
  passkeyDetails,
  passkeyPlace,
  passkeyProvider,
  passkeyUserHandle,
  requestOrigin,
} from 'src/utils/passkey.js';

/* eslint-disable unicorn/prefer-https -- plain http addresses are what these rules refuse */
describe('passkeyPlace (FL-836)', () => {
  const trusted = ['https://photos.example.com', 'https://r.abc.frameleaf.net', null, 'http://plain.example.com'];

  it('accepts the external domain and the Frameleaf addresses over https', () => {
    expect(passkeyPlace('https://photos.example.com', trusted)).toEqual({
      available: true,
      origin: 'https://photos.example.com',
      rpId: 'photos.example.com',
    });
    expect(passkeyPlace('https://r.abc.frameleaf.net', trusted)).toMatchObject({ rpId: 'r.abc.frameleaf.net' });
  });

  it('accepts localhost, also over http', () => {
    expect(passkeyPlace('http://localhost:2283', [])).toEqual({
      available: true,
      origin: 'http://localhost:2283',
      rpId: 'localhost',
    });
  });

  it('says plain http is the reason on a home address', () => {
    expect(passkeyPlace('http://192.168.1.20:2283', trusted)).toEqual({ available: false, reason: 'insecure' });
    expect(passkeyPlace('http://plain.example.com', trusted)).toEqual({ available: false, reason: 'insecure' });
  });

  it('refuses any other https address, an IP address and a missing origin', () => {
    expect(passkeyPlace('https://photos.evil.test', trusted)).toEqual({ available: false, reason: 'address' });
    expect(passkeyPlace('https://192.168.1.20', ['https://192.168.1.20'])).toEqual({
      available: false,
      reason: 'address',
    });
    expect(passkeyPlace(null, trusted)).toEqual({ available: false, reason: 'address' });
    expect(passkeyPlace('null', trusted)).toEqual({ available: false, reason: 'address' });
  });
});

describe('passkey helpers (FL-836)', () => {
  it('reads the origin from the Origin header, else from the host', () => {
    expect(requestOrigin({ origin: 'https://photos.example.com' }, false)).toBe('https://photos.example.com');
    expect(requestOrigin({ host: 'photos.example.com' }, true)).toBe('https://photos.example.com');
    expect(requestOrigin({ host: '192.168.1.20:2283' }, false)).toBe('http://192.168.1.20:2283');
    expect(requestOrigin({}, true)).toBeNull();
  });

  it('takes the edge worker’s word for https, never a plain request’s', () => {
    const details = { isSecure: false, clientIp: '', deviceType: '', deviceOS: '', appVersion: null };
    expect(passkeyDetails({ frameleafForwarded: { proto: 'https' } } as never, details).isSecure).toBe(true);
    expect(passkeyDetails({ headers: { 'x-forwarded-proto': 'https' } } as never, details).isSecure).toBe(false);
  });

  it('uses the account id as the user handle, never the email', () => {
    expect(Buffer.from(passkeyUserHandle('0190a0b0-0000-7000-8000-000000000001')).toString('hex')).toBe(
      '0190a0b0000070008000000000000001',
    );
  });

  it('reads the challenge a browser answered', () => {
    const data = Buffer.from(JSON.stringify({ challenge: 'abc' })).toString('base64url');
    expect(answeredChallenge(data)).toBe('abc');
    expect(answeredChallenge('not json')).toBeNull();
    expect(answeredChallenge(undefined)).toBeNull();
  });

  it('names well-known password managers only', () => {
    expect(passkeyProvider('EA9B8D66-4D01-1D21-3CE4-B6B48CB575D4')).toBe('Google Password Manager');
    expect(passkeyProvider('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(passkeyProvider(null)).toBeNull();
  });
});
