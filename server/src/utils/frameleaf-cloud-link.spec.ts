import { describe, expect, it } from 'vitest';
import { defaults } from 'src/dtos/config.dto.js';
import { MlAdmissionRefusal } from 'src/enum.js';
import {
  DATA_REGIONS,
  HEARTBEAT_FIELDS,
  LINK_REFUSAL_MESSAGES,
  accountLabelOf,
  buildHeartbeat,
  commandPermission,
  defaultPermissions,
  heartbeatResponseSchema,
  instanceRegistrationSchema,
  isUserCode,
  keyNonceSchema,
  linkEndpoints,
  linkRefusalOf,
  nextHeartbeatDelay,
  permissionsOf,
  regionMismatchOf,
  rememberNotices,
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
    const golden = cloudContractFixture('instance/heartbeat-request.json');
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
      capabilities: ['dpop', '', 'x'.repeat(33), ...Array.from({ length: 20 }, (_, index) => `c${index}`)],
      remoteAccessSettings: { ...golden.remoteAccessSettings, publicHostname: 'photos.example.com' },
      cloudMl: golden.cloudMl,
      cloudBackup: golden.cloudBackup,
      licenseState: 'active',
      albums: ['private'],
    } as never);
    // FC-61: a block carrying any other key is left out, never sent
    expect(Object.keys(payload)).toEqual(HEARTBEAT_FIELDS.filter((field) => field !== 'remoteAccessSettings'));
    expect(JSON.stringify(payload)).not.toContain('photos.example.com');
    // the cloud's bounds (FC-50): at most 16 entries of 1 to 32 characters
    expect(payload.capabilities).toHaveLength(16);
    expect(payload.capabilities![0]).toBe('dpop');
    expect(payload.capabilities!.every((value) => value.length > 0 && value.length <= 32)).toBe(true);
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
    expect(commandPermission('entitlements.refresh')).toBe('allowEntitlementRefresh');
    expect(commandPermission('relink')).toBe('always');
    expect(commandPermission('data.delete')).toBeNull();
  });

  it('clamps the cloud’s interval hint to 60–900 s (FC-62) and adds up to 30 seconds of jitter', () => {
    expect(nextHeartbeatDelay(undefined, () => 0)).toBe(300);
    expect(nextHeartbeatDelay(5, () => 0)).toBe(60);
    expect(nextHeartbeatDelay(999_999, () => 0)).toBe(900);
    expect(nextHeartbeatDelay(901, () => 0)).toBe(900);
    expect(nextHeartbeatDelay(59, () => 0)).toBe(60);
    expect(nextHeartbeatDelay(120, () => 0.999)).toBe(149);
  });

  it('uses the answer’s nextHeartbeatSec, else discovery’s heartbeatSec, else 300 s (FC-62)', () => {
    expect(nextHeartbeatDelay(120, () => 0, 600)).toBe(120);
    expect(nextHeartbeatDelay(undefined, () => 0, 600)).toBe(600);
    expect(nextHeartbeatDelay(null, () => 0, 30)).toBe(60);
    expect(nextHeartbeatDelay(null, () => 0, 86_400)).toBe(900);
    expect(nextHeartbeatDelay(null, () => 0, NaN)).toBe(300);
    expect(nextHeartbeatDelay(null, () => 0, -5)).toBe(300);
    expect(nextHeartbeatDelay(0, () => 0, 450)).toBe(450);
  });

  it('reads an out-of-range or malformed nextHeartbeatSec as absent instead of failing the check-in (FC-62)', () => {
    expect(heartbeatResponseSchema.parse({ nextHeartbeatSec: 100_000 }).nextHeartbeatSec).toBe(100_000);
    expect(
      nextHeartbeatDelay(heartbeatResponseSchema.parse({ nextHeartbeatSec: 100_000 }).nextHeartbeatSec, () => 0),
    ).toBe(900);
    expect(heartbeatResponseSchema.parse({ nextHeartbeatSec: -1 }).nextHeartbeatSec).toBeUndefined();
    expect(heartbeatResponseSchema.parse({ nextHeartbeatSec: 'soon' }).nextHeartbeatSec).toBeUndefined();
  });

  describe(rememberNotices.name, () => {
    const uuid = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';
    const day = 24 * 60 * 60 * 1000;
    const start = Date.parse('2026-09-27T08:00:00Z');

    it('shows a notice once by its exact id, for as long as the cloud keeps sending it (90 days)', () => {
      const first = rememberNotices(undefined, [`fc-notice-${uuid}`], start);
      expect(first.fresh).toEqual([`fc-notice-${uuid}`]);
      let shown = first.shown;
      for (let at = start + 300_000; at < start + 90 * day; at += day / 2) {
        const next = rememberNotices(shown, [`fc-notice-${uuid}`], at);
        expect(next.fresh).toEqual([]);
        shown = next.shown;
      }
    });

    it('shows a notice that cannot be dismissed once a UTC day under its daily id, never more often', () => {
      let shown: Record<string, string> | undefined;
      const seen: string[] = [];
      for (let beat = 0; beat < 3 * 288; beat++) {
        const at = start + beat * 300_000;
        const date = new Date(at).toISOString().slice(0, 10).replaceAll('-', '');
        const next = rememberNotices(shown, [`fc-notice-${uuid}-${date}`], at);
        seen.push(...next.fresh);
        shown = next.shown;
      }
      // three days of five-minute check-ins from 08:00 UTC touch four UTC days
      expect(seen).toEqual([
        `fc-notice-${uuid}-20260927`,
        `fc-notice-${uuid}-20260928`,
        `fc-notice-${uuid}-20260929`,
        `fc-notice-${uuid}-20260930`,
      ]);
      // a daily id is forgotten after two days, so the memory stays small
      expect(Object.keys(shown!)).not.toContain(`fc-notice-${uuid}-20260927`);
    });

    it('shows an FC-61 notice again once under its new fc-notice id, then never again', () => {
      const legacy = rememberNotices(undefined, [uuid], start);
      const moved = rememberNotices(legacy.shown, [`fc-notice-${uuid}`], start + 300_000);
      expect(moved.fresh).toEqual([`fc-notice-${uuid}`]);
      expect(rememberNotices(moved.shown, [`fc-notice-${uuid}`], start + 600_000).fresh).toEqual([]);
    });

    it('dedupes within one answer, forgets after 91 days and keeps at most 500 ids', () => {
      expect(rememberNotices(undefined, ['a', 'a', 'b'], start).fresh).toEqual(['a', 'b']);
      const old = rememberNotices(undefined, ['a'], start).shown;
      expect(rememberNotices(old, ['a'], start + 92 * day).fresh).toEqual(['a']);
      const many = rememberNotices(
        undefined,
        Array.from({ length: 600 }, (_, index) => `n-${index}`),
        start,
      );
      expect(Object.keys(many.shown)).toHaveLength(500);
      expect(rememberNotices({ a: 'not a date' }, ['a'], start).fresh).toEqual(['a']);
    });
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
    expect(linkRefusalOf(refused(409, 'region-mismatch'))).toBe('region-mismatch');
    // the ML gateway's 403 region-mismatch is not a link refusal of this kind
    expect(linkRefusalOf(refused(403, 'region-mismatch'))).toBe('server-refused');
    expect(linkRefusalOf(refused(402, 'insufficient-credits'))).toBeNull();
    expect(linkRefusalOf(refused(409, 'conflict'))).toBeNull();
    expect(linkRefusalOf(refused(503, 'internal'))).toBeNull();
    expect(linkRefusalOf(new Error('x'))).toBeNull();
    for (const message of Object.values(LINK_REFUSAL_MESSAGES)) {
      expect(message).not.toMatch(/please|successfully|simply/i);
    }
  });

  it('reads a 409 region-mismatch with the cloud’s message and both regions (FC-18)', () => {
    const refused = (status: number, data: Record<string, unknown> | null, message = 'Keeps its data in the EU.') =>
      new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, status, 'x', {
        code: 'region-mismatch',
        message,
        retryable: false,
        refusal: null,
        detail: null,
        data,
        requestId: null,
      });
    expect(regionMismatchOf(refused(409, { accountRegion: 'eu', requestedRegion: 'na' }))).toEqual({
      accountRegion: 'eu',
      requestedRegion: 'na',
      message: 'Keeps its data in the EU.',
    });
    expect(regionMismatchOf(refused(409, { accountRegion: 'na' }, ' '))).toEqual({
      accountRegion: 'na',
      requestedRegion: undefined,
      message: LINK_REFUSAL_MESSAGES['region-mismatch'],
    });
    // no usable account region, or the ML gateway's 403: nothing to link in
    expect(regionMismatchOf(refused(409, { accountRegion: 'mars' }))).toBeNull();
    expect(regionMismatchOf(refused(409, null))).toBeNull();
    expect(regionMismatchOf(refused(403, { accountRegion: 'eu' }))).toBeNull();
    expect(regionMismatchOf(new Error('x'))).toBeNull();
    expect(DATA_REGIONS).toEqual(['eu', 'na']);
  });

  it('builds the golden heartbeat request exactly (FC-19 fixtures)', () => {
    const golden = cloudContractFixture('instance/heartbeat-request.json');
    expect(buildHeartbeat(golden)).toEqual(golden);
    expect(Object.keys(golden)).toEqual([...HEARTBEAT_FIELDS]);
  });

  it('reads the golden heartbeat answer: commands, notices and pricing, extra fields ignored', () => {
    const answer = heartbeatResponseSchema.parse(cloudContractFixture('instance/heartbeat-response.json'));
    expect(answer).toMatchObject({
      commands: [{ id: '0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e0f', type: 'backup.run' }],
      entitlementsChanged: false,
      servicesChanged: false,
      nextHeartbeatSec: 300,
      cloneSuspected: false,
      notices: [{ id: 'maintenance-2026-10-01', level: 'info' }],
      pricing: { pricesVersion: '2026-09-25.1', licensedDiscountPercent: 20, effectiveFrom: '2026-09-25T00:00:00Z' },
      observedIp: '203.0.113.7',
    });
    // FL-167: an observed address that is not one is dropped, never failing the check-in
    expect(heartbeatResponseSchema.parse({ observedIp: 'not-an-ip' }).observedIp).toBeNull();
    expect(commandPermission(answer.commands[0].type)).toBe('allowBackupTrigger');
    const polled = heartbeatResponseSchema.shape.commands.parse(
      cloudContractFixture('instance/commands-poll-response.json').commands,
    );
    expect(polled.map(({ type }) => commandPermission(type))).toEqual(['allowRemoteEnable']);
  });

  it('reads the golden key rotation nonce', () => {
    expect(keyNonceSchema.parse(cloudContractFixture('instance/key-nonce-response.json'))).toEqual({
      nonce: 'BGLOnAp_vMX9Y-YITAxJheRWVqJbSLcpHkqrmuDqmX0',
    });
  });

  it('defaults the permission toggles as the prototype does', () => {
    expect(permissionsOf(null)).toEqual({
      allowRemoteEnable: false,
      allowBackupTrigger: true,
      allowEntitlementRefresh: true,
    });
  });
});

/**
 * FL-201 (confirmed against the frameleaf-cloud instance contract, 2026-09-29): cloud backup and the
 * remote-access relay take no versioned consent; they are off until an administrator turns them on,
 * and Frameleaf Cloud cannot turn remote access on unless an administrator allowed it.
 */
describe('Frameleaf Cloud opt-in defaults (FL-201)', () => {
  it('keeps cloud backup and remote access off until an administrator turns them on', () => {
    expect(defaults.frameleafCloud.cloudBackup).toMatchObject({ enabled: false, target: 'off' });
    expect(defaults.frameleafCloud.remoteAccess.enabled).toBe(false);
  });

  it('does not let Frameleaf Cloud turn remote access on by default', () => {
    expect(defaultPermissions().allowRemoteEnable).toBe(false);
  });
});
