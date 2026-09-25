import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_FIELDS,
  buildHeartbeat,
  commandPermission,
  isUserCode,
  nextHeartbeatDelay,
  permissionsOf,
  redirectUris,
} from 'src/utils/frameleaf-cloud-link.js';

describe('frameleaf-cloud-link (FL-155)', () => {
  it('accepts only XXXX-XXXX user codes from the consonant alphabet', () => {
    expect(isUserCode('BCDF-GHJK')).toBe(true);
    expect(isUserCode('BCDA-GHJK')).toBe(false);
    expect(isUserCode('BCDFGHJK')).toBe(false);
    expect(isUserCode('bcdf-ghjk')).toBe(false);
  });

  it('builds a heartbeat with exactly the listed fields, dropping anything else', () => {
    const payload = buildHeartbeat({
      version: '3.2.0',
      bootId: 'boot',
      uptimeSec: 12.7,
      health: { database: 'ok', storage: 'ok', jobs: 'ok', secret: 'x' } as never,
      endpoints: Array.from({ length: 20 }, (_, index) => ({
        kind: 'lan',
        url: `https://h${index}`,
        extra: 1,
      })) as never,
      remoteAccess: { enabled: false, relayConnected: false, direct: false },
      permissions: { allowRemoteEnable: true, email: 'x' } as never,
      licenseKid: null,
      albums: ['private'],
    } as never);
    expect(Object.keys(payload)).toEqual([...HEARTBEAT_FIELDS]);
    expect(payload.uptimeSec).toBe(12);
    expect(payload.health).toEqual({ database: 'ok', storage: 'ok', jobs: 'ok' });
    expect(payload.endpoints).toHaveLength(16);
    expect(payload.endpoints[0]).toEqual({ kind: 'lan', url: 'https://h0' });
    expect(payload.permissions).toEqual({
      allowRemoteEnable: true,
      allowBackupTrigger: true,
      allowEntitlementRefresh: true,
    });
    expect(JSON.stringify(payload)).not.toContain('private');
  });

  it('maps every command to the toggle that gates it', () => {
    expect(commandPermission('remote.enable')).toBe('allowRemoteEnable');
    expect(commandPermission('remote.disable')).toBe('allowRemoteEnable');
    expect(commandPermission('backup.run')).toBe('allowBackupTrigger');
    expect(commandPermission('secret.rotate')).toBe('allowEntitlementRefresh');
    expect(commandPermission('key.rotate')).toBe('allowEntitlementRefresh');
    expect(commandPermission('relink')).toBe('always');
    expect(commandPermission('data.delete')).toBeNull();
  });

  it('clamps the cloud’s interval hint and adds up to 30 seconds of jitter', () => {
    expect(nextHeartbeatDelay(undefined, () => 0)).toBe(300);
    expect(nextHeartbeatDelay(5, () => 0)).toBe(60);
    expect(nextHeartbeatDelay(999_999, () => 0)).toBe(3600);
    expect(nextHeartbeatDelay(120, () => 0.999)).toBe(149);
  });

  it('registers web and native callbacks on each public origin', () => {
    expect(redirectUris(['https://photos.example.test/some/path', 'not a url', 'ftp://x.test'])).toEqual([
      'https://photos.example.test/auth/login',
      'https://photos.example.test/user-settings',
      'https://photos.example.test/link',
      'https://photos.example.test/api/oauth/mobile-redirect',
      'frameleaf-auth:///oauth-callback',
    ]);
  });

  it('defaults the permission toggles as the prototype does', () => {
    expect(permissionsOf(null)).toEqual({
      allowRemoteEnable: false,
      allowBackupTrigger: true,
      allowEntitlementRefresh: true,
    });
  });
});
