import { createHash } from 'node:crypto';
import { fromChecksum, getAppVersionFromUA, getUserAgentDetails } from 'src/utils/request.js';

describe(fromChecksum.name, () => {
  const sha1Buffer = createHash('sha1').update('hello').digest();
  const sha256Buffer = createHash('sha256').update('hello').digest();

  it('decodes a SHA-1 hex string (40 chars) into a 20-byte buffer', () => {
    const result = fromChecksum(sha1Buffer.toString('hex'));
    expect(result.equals(sha1Buffer)).toBe(true);
    expect(result.length).toBe(20);
  });

  it('decodes a SHA-1 base64 string (28 chars) into a 20-byte buffer', () => {
    const result = fromChecksum(sha1Buffer.toString('base64'));
    expect(result.equals(sha1Buffer)).toBe(true);
    expect(result.length).toBe(20);
  });

  it('decodes a SHA-256 hex string (64 chars) into a 32-byte buffer', () => {
    const result = fromChecksum(sha256Buffer.toString('hex'));
    expect(result.equals(sha256Buffer)).toBe(true);
    expect(result.length).toBe(32);
  });

  it('decodes a SHA-256 base64 string (44 chars) into a 32-byte buffer', () => {
    const result = fromChecksum(sha256Buffer.toString('base64'));
    expect(result.equals(sha256Buffer)).toBe(true);
    expect(result.length).toBe(32);
  });

  it('does not confuse SHA-1 and SHA-256 digests', () => {
    expect(fromChecksum(sha1Buffer.toString('hex')).equals(sha256Buffer)).toBe(false);
    expect(fromChecksum(sha256Buffer.toString('hex')).equals(sha1Buffer)).toBe(false);
  });
});

describe(getAppVersionFromUA.name, () => {
  it.each(['android', 'ios', 'unknown'])('gets the Frameleaf %s app version', (platform) => {
    expect(getAppVersionFromUA(`frameleaf-${platform}/3.2.0`)).toBe('3.2.0');
  });

  it.each([
    '',
    'frameleaf-ios/',
    'frameleaf-desktop/3.2.0',
    'Frameleaf-ios/3.2.0',
    'frameleaf-iOS/3.2.0',
    'prefix frameleaf-ios/3.2.0',
    'frameleaf-ios/3.2.0\nextra',
    'immich-ios/',
    'immich-iOS/3.2.0',
    'Immich_ios_3.2.0',
  ])('rejects unsupported or incomplete user agents: %j', (userAgent) => {
    expect(getAppVersionFromUA(userAgent)).toBeNull();
  });

  it('should get the app version for android', () => {
    expect(getAppVersionFromUA('immich-android/1.123.4')).toEqual('1.123.4');
  });

  it('should get the app version for ios', () => {
    expect(getAppVersionFromUA('immich-ios/1.123.4')).toEqual('1.123.4');
  });

  it('should get the app version for unknown', () => {
    expect(getAppVersionFromUA('immich-unknown/1.123.4')).toEqual('1.123.4');
  });

  describe('legacy format', () => {
    it('should get the app version from the old android format', () => {
      expect(getAppVersionFromUA('Immich_Android_1.123.4')).toEqual('1.123.4');
    });

    it('should get the app version from the old ios format', () => {
      expect(getAppVersionFromUA('Immich_iOS_1.123.4')).toEqual('1.123.4');
    });

    it('should get the app version from the old unknown format', () => {
      expect(getAppVersionFromUA('Immich_Unknown_1.123.4')).toEqual('1.123.4');
    });
  });
});

describe(getUserAgentDetails.name, () => {
  it('includes the Frameleaf version and retains fallback device headers', () => {
    expect(
      getUserAgentDetails({ 'user-agent': 'frameleaf-ios/3.2.0', devicemodel: 'phone', devicetype: 'iOS' }),
    ).toEqual({ deviceType: 'phone', deviceOS: 'iOS', appVersion: '3.2.0' });
  });

  it('retains empty details when user-agent and device headers are absent', () => {
    expect(getUserAgentDetails({})).toEqual({ deviceType: '', deviceOS: '', appVersion: null });
  });
});
