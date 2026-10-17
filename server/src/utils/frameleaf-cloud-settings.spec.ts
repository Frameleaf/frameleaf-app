import { describe, expect, it } from 'vitest';
import type { FrameleafCloudBackup, FrameleafLicense } from 'src/types.js';
import { defaults } from 'src/config.js';
import {
  CLOUD_BACKUP_REPORTS_OWN_BUCKET,
  cloudBackupSettingsOf,
  cloudBackupSettingsSchema,
  cloudMlSettingsOf,
  cloudMlSettingsSchema,
  licenseStateOf,
  licenseStateSchema,
  remoteAccessSettingsOf,
  remoteAccessSettingsSchema,
} from 'src/utils/frameleaf-cloud-settings.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

const cloud = defaults.frameleafCloud;

const backup = (overrides: Partial<FrameleafCloudBackup> = {}): FrameleafCloudBackup =>
  ({
    target: 'managed',
    bucketRef: 'https://s3.test/fl-eu-x',
    endpoint: 'https://s3.test',
    region: 'eu',
    bucket: 'fl-eu-x',
    instanceId: 'instance-1',
    claimedAt: '2026-09-20T00:00:00.000Z',
    keyMode: 'own-stored',
    keyFingerprint: 'ABCD-EFGH',
    ...overrides,
  }) as FrameleafCloudBackup;

describe('the check-in settings snapshot (FL-159, FC-61)', () => {
  it('reads the golden heartbeat request’s blocks with the same strict schemas the cloud uses', () => {
    const golden = cloudContractFixture('instance/heartbeat-request.json');
    expect(remoteAccessSettingsSchema.parse(golden.remoteAccessSettings)).toEqual(golden.remoteAccessSettings);
    expect(cloudMlSettingsSchema.parse(golden.cloudMl)).toEqual(golden.cloudMl);
    expect(cloudBackupSettingsSchema.parse(golden.cloudBackup)).toEqual(golden.cloudBackup);
    expect(licenseStateSchema.parse(golden.licenseState)).toBe('none');
    // any other key is refused, as on the cloud
    expect(remoteAccessSettingsSchema.safeParse({ ...golden.remoteAccessSettings, host: 'x' }).success).toBe(false);
  });

  describe(remoteAccessSettingsOf.name, () => {
    it('reports the mode, port and relay options, and which kind of public name, never the name itself', () => {
      const settings = remoteAccessSettingsOf({
        ...cloud.remoteAccess,
        enabled: true,
        mode: 'relay-and-direct',
        publicUrl: 'custom',
        customHostname: { host: 'photos.example.com', status: 'verified', checkedAt: null },
      });
      expect(settings).toEqual({
        mode: 'relay-and-direct',
        directPort: 2443,
        portMapping: true,
        allowOriginalsOverRelay: false,
        allowPasswordOverRelay: false,
        publicUrl: 'custom',
        requireFrameleafSignIn: true,
      });
      expect(JSON.stringify(settings)).not.toContain('example.com');
    });

    it('says Frameleaf sign-in is not required once password sign-in over the relay is allowed', () => {
      expect(remoteAccessSettingsOf({ ...cloud.remoteAccess, allowPasswordOverRelay: true })).toMatchObject({
        allowPasswordOverRelay: true,
        requireFrameleafSignIn: false,
      });
    });

    it('leaves the block out rather than send a value the contract refuses', () => {
      expect(remoteAccessSettingsOf({ ...cloud.remoteAccess, directPort: 70_000 })).toBeUndefined();
      expect(remoteAccessSettingsOf({ ...cloud.remoteAccess, mode: 'direct' as never })).toBeUndefined();
      expect(remoteAccessSettingsOf({ ...cloud.remoteAccess, directPort: NaN })).toMatchObject({
        directPort: null,
      });
      expect(remoteAccessSettingsOf(undefined)).toBeUndefined();
    });
  });

  describe(cloudMlSettingsOf.name, () => {
    it('maps each route to the canonical workloads, Studio AI to transcription, and autoDescribe to autoBatch', () => {
      const settings = cloudMlSettingsOf(
        {
          ...cloud.cloudMl,
          enabled: true,
          routing: {
            descriptions: 'both',
            upscale: 'cloud',
            restoration: 'local',
            studio: 'cloud',
            interpolation: 'both',
          },
          autoDescribe: { enabled: true, dailyBudgetUsd: 3.5 },
        },
        '2026-09-26.1',
      );
      expect(settings).toEqual({
        enabled: true,
        routing: {
          descriptions: 'both',
          upscale: 'cloud-only',
          restoration: 'local-only',
          transcription: 'cloud-only',
          interpolation: 'both',
        },
        autoBatch: true,
        dailyBudgetUsd: 3.5,
        consentVersion: '2026-09-26.1',
        faces: false,
      });
    });

    it('reports no accepted terms as null, and leaves the block out for values the contract refuses', () => {
      expect(cloudMlSettingsOf(cloud.cloudMl, null)).toMatchObject({ consentVersion: null, enabled: false });
      expect(cloudMlSettingsOf(cloud.cloudMl, '2026-09-25')).toBeUndefined();
      expect(
        cloudMlSettingsOf({ ...cloud.cloudMl, autoDescribe: { enabled: true, dailyBudgetUsd: 20_000 } }, null),
      ).toBeUndefined();
      expect(cloudMlSettingsOf(undefined, null)).toBeUndefined();
    });

    it('leaves out a workload this server does not offer and a route it does not know', () => {
      const settings = cloudMlSettingsOf(
        { ...cloud.cloudMl, routing: { ...cloud.cloudMl.routing, music: 'cloud', upscale: 'sometimes' } as never },
        null,
      );
      expect(Object.keys(settings!.routing).toSorted()).toEqual(
        ['descriptions', 'interpolation', 'restoration', 'transcription'].toSorted(),
      );
    });
  });

  describe(cloudBackupSettingsOf.name, () => {
    it('reports Frameleaf-managed storage, its key mode, schedule, retention and how the last run ended', () => {
      const settings = cloudBackupSettingsOf(
        { ...cloud.cloudBackup, enabled: true, target: 'managed', keyMode: 'server', escrow: true },
        backup({
          escrow: { storedAt: '2026-09-21T00:00:00.000Z' },
          lastRun: {
            operationId: 'run-1',
            status: 'failed',
            startedAt: '2026-09-25T03:00:00.000Z',
            uploaded: 1,
            skipped: 0,
            missing: 0,
            bytesUploaded: 10,
            error: '/srv/photos/secret.jpg could not be read',
          },
        }),
      );
      expect(settings).toEqual({
        target: 'managed',
        keyMode: 'own-stored',
        schedule: '0 3 * * *',
        retention: { daily: 7, weekly: 4, monthly: 12 },
        verifyWeekly: true,
        escrow: true,
        lastRun: { at: '2026-09-25T03:00:00.000Z', result: 'failed' },
      });
      // never the server's error text
      expect(JSON.stringify(settings)).not.toContain('secret');
    });

    it('reports cloud backup that is off, with no schedule and no run', () => {
      expect(cloudBackupSettingsOf(cloud.cloudBackup, null)).toEqual({
        target: 'off',
        keyMode: 'server',
        schedule: null,
        retention: { daily: 7, weekly: 4, monthly: 12 },
        verifyWeekly: true,
        escrow: false,
        lastRun: null,
      });
    });

    it('reports a run waiting for its key as paused', () => {
      const settings = cloudBackupSettingsOf(
        { ...cloud.cloudBackup, enabled: true, target: 'managed' },
        backup({
          lastRun: {
            operationId: 'run-2',
            status: 'waiting-for-key',
            startedAt: '2026-09-26T03:00:00.000Z',
            uploaded: 0,
            skipped: 0,
            missing: 0,
            bytesUploaded: 0,
          },
        }),
      );
      expect(settings?.lastRun).toEqual({ at: '2026-09-26T03:00:00.000Z', result: 'paused' });
    });

    it('reports the admin’s own bucket as own-bucket, never its name, endpoint or keys (frameleaf-cloud PR #78)', () => {
      const own = { ...cloud.cloudBackup, enabled: true, target: 'byo-s3' as const, keyMode: 'own-memory' as const };
      expect(CLOUD_BACKUP_REPORTS_OWN_BUCKET).toBe(true);
      // with the switch off, the block is left out rather than misreported as off
      expect(cloudBackupSettingsOf(own, backup({ target: 'byo-s3', keyMode: 'own-memory' }), false)).toBeUndefined();
      const settings = cloudBackupSettingsOf(own, backup({ target: 'byo-s3', keyMode: 'own-memory' }));
      expect(JSON.stringify(settings)).not.toMatch(/fl-eu-x|s3\.test/);
      expect(settings).toEqual({
        target: 'own-bucket',
        keyMode: 'own-memory',
        schedule: '0 3 * * *',
        retention: { daily: 7, weekly: 4, monthly: 12 },
        verifyWeekly: true,
        escrow: false,
        lastRun: null,
      });
    });

    it('leaves the block out for values the contract refuses', () => {
      expect(
        cloudBackupSettingsOf(
          { ...cloud.cloudBackup, enabled: true, target: 'managed', schedule: { cronExpression: '0 3 * * MON' } },
          backup(),
        ),
      ).toBeUndefined();
      expect(
        cloudBackupSettingsOf(
          {
            ...cloud.cloudBackup,
            enabled: true,
            target: 'managed',
            retention: { keepDaily: 400, keepWeekly: 4, keepMonthly: 12 },
          },
          backup(),
        ),
      ).toBeUndefined();
      expect(cloudBackupSettingsOf(undefined, null)).toBeUndefined();
    });
  });

  describe(licenseStateOf.name, () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const license = (claims: Partial<FrameleafLicense['claims']>) =>
      ({
        claims: { iat: nowSeconds, exp: nowSeconds + 86_400, lic_exp: nowSeconds + 86_400, ent: ['CLOUD'], ...claims },
      }) as FrameleafLicense;

    it('reports the state of the certificate this server leads with', () => {
      expect(licenseStateOf(null)).toBe('none');
      expect(licenseStateOf({ key: null, plan: license({}) })).toBe('active');
      expect(licenseStateOf({ key: null, plan: license({ lic_exp: nowSeconds - 86_400, grace_days: 7 }) })).toBe(
        'grace',
      );
      expect(licenseStateOf({ key: null, plan: license({ lic_exp: nowSeconds - 30 * 86_400, grace_days: 7 }) })).toBe(
        'expired',
      );
    });
  });
});
