import { describe, expect, it } from 'vitest';
import { MlAdmissionRefusal } from 'src/enum.js';
import {
  HEARTBEAT_FIELDS,
  LINK_REFUSAL_MESSAGES,
  accountLabelOf,
  buildHeartbeat,
  commandPermission,
  instanceRegistrationSchema,
  isUserCode,
  linkEndpoints,
  linkRefusalOf,
  nextHeartbeatDelay,
  permissionsOf,
} from 'src/utils/frameleaf-cloud-link.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

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

  it('reads the golden registration answer: the cloud registered the client, no initial access token', () => {
    const answer = cloudContractFixture('instance/register-response.json');
    const registration = instanceRegistrationSchema.parse({
      ...answer,
      oidc: { ...answer.oidc, initialAccessToken: 'x' },
    });
    expect(registration).toEqual({
      instanceId: '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53',
      oidc: {
        issuer: 'https://id.frameleaf.cloud',
        clientId: '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53',
        scope: 'openid email profile',
        roleClaim: 'frameleaf_role',
        storageLabelClaim: '',
      },
      services: {},
      owner: {
        accountId: '0192f1a0-1111-7aaa-8bbb-123456789abc',
        label: 'Ana',
        email: 'ana@example.com',
        dataRegion: 'eu',
      },
    });
    // anything about dynamic client registration is ignored: this server never runs it (decisions #7–#9)
    expect(JSON.stringify(registration)).not.toContain('initialAccessToken');
    expect(accountLabelOf(registration.owner)).toBe('Ana');
  });

  it('builds no client registration address any more', () => {
    const endpoints = linkEndpoints({ issuer: 'https://id.frameleaf.cloud', api: 'https://api.frameleaf.cloud' });
    expect(endpoints).not.toHaveProperty('registration');
    expect(endpoints.instances).toBe('https://api.frameleaf.cloud/v1/instances');
  });

  it('names the registration refusals an administrator can act on (FL-177)', () => {
    const refused = (status: number, code: string) =>
      new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, status, 'x', {
        code,
        message: '',
        retryable: false,
        refusal: null,
        detail: null,
        data: null,
        requestId: null,
      });
    expect(linkRefusalOf(refused(402, 'instance-limit'))).toBe('instance-limit');
    expect(linkRefusalOf(refused(403, 'instance_revoked'))).toBe('server-refused');
    expect(linkRefusalOf(refused(403, 'forbidden'))).toBe('server-refused');
    expect(linkRefusalOf(refused(409, 'instance-id-taken'))).toBe('instance-id-taken');
    expect(linkRefusalOf(refused(409, 'jwk_already_bound'))).toBe('key-already-linked');
    expect(linkRefusalOf(refused(402, 'insufficient-credits'))).toBeNull();
    expect(linkRefusalOf(refused(409, 'conflict'))).toBeNull();
    expect(linkRefusalOf(refused(503, 'internal'))).toBeNull();
    expect(linkRefusalOf(new Error('x'))).toBeNull();
    for (const message of Object.values(LINK_REFUSAL_MESSAGES)) {
      expect(message).not.toMatch(/please|successfully|simply/i);
    }
  });

  it('defaults the permission toggles as the prototype does', () => {
    expect(permissionsOf(null)).toEqual({
      allowRemoteEnable: false,
      allowBackupTrigger: true,
      allowEntitlementRefresh: true,
    });
  });
});
