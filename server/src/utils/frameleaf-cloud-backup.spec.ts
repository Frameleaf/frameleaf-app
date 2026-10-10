import { MlAdmissionRefusal } from 'src/enum.js';
import {
  backupAgentSettingsSchema,
  backupEndpoints,
  backupGrantMetadataSchema,
  backupGrantProblem,
  backupGrantRequestSchema,
  backupGrantResponseSchema,
  backupLocationsSchema,
  backupRunReportSchema,
  backupUsageSchema,
  keyEscrowRecordSchema,
  managedBackupRefusal,
  managedStorageRef,
} from 'src/utils/frameleaf-cloud-backup.js';
import { FrameleafCloudError, errorEnvelopeSchema } from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

const cloudError = (status: number, fixture: string, retryAfterSeconds: number | null = null) =>
  new FrameleafCloudError(
    MlAdmissionRefusal.CloudUnavailable,
    status,
    'refused',
    errorEnvelopeSchema.parse(cloudContractFixture(fixture)),
    null,
    retryAfterSeconds,
  );

describe('Frameleaf Cloud managed backup contract (FL-164)', () => {
  it('reads the grant, its rotation and its metadata as Frameleaf Cloud publishes them', () => {
    const grant = backupGrantResponseSchema.parse(cloudContractFixture('backup/grant-response.json'));
    const rotated = backupGrantResponseSchema.parse(cloudContractFixture('backup/grant-rotate-response.json'));
    const metadata = backupGrantMetadataSchema.parse(cloudContractFixture('backup/grant-metadata.json'));

    expect(grant.bucket).toMatch(/^fl-eu-/);
    expect(grant.sseC).toEqual({ required: true, algorithm: 'AES256' });
    expect(rotated.credentials.accessKeyId).not.toBe(grant.credentials.accessKeyId);
    expect(rotated.previousKeyExpiresAt).not.toBeNull();
    expect(backupGrantProblem(grant)).toBeNull();
    expect(metadata.readOnly).toBe(false);
  });

  it('refuses metadata that carries a secret, and a grant whose policy lets versions be deleted', () => {
    const grant = cloudContractFixture('backup/grant-response.json');
    const permissive = { ...grant, policy: { denies: ['s3:DeleteBucket', 's3:PutBucketVersioning'] } };

    expect(backupGrantMetadataSchema.safeParse(grant).success).toBe(false);
    expect(backupGrantProblem(backupGrantResponseSchema.parse(permissive))).toContain('s3:DeleteObjectVersion');
  });

  it('requires versioned branded grant metadata, stable identity and a location-only request', () => {
    const grant = cloudContractFixture('backup/grant-response.json');
    expect(managedStorageRef(grant.storageId)).toBe(`frameleaf-storage:${grant.storageId}`);
    expect(backupGrantResponseSchema.safeParse({ ...grant, version: 1 }).success).toBe(false);
    expect(backupGrantResponseSchema.safeParse({ ...grant, endpoint: 'https://storage.example' }).success).toBe(false);
    expect(backupGrantRequestSchema.safeParse({ locationId: 'loc-07', endpoint: grant.endpoint }).success).toBe(false);
    const location = { ...grant.location, probeUrl: grant.endpoint };
    expect(backupLocationsSchema.parse({ version: 2, locations: [location] }).locations).toEqual([location]);
    expect(
      backupLocationsSchema.safeParse({ version: 2, locations: [{ ...location, region: grant.region }] }).success,
    ).toBe(false);
  });

  it("accepts the cloud's plan_full read-only reason (FL-301, FC-91)", () => {
    const usage = backupUsageSchema.parse(cloudContractFixture('backup/usage-plan-full.json'));
    expect(usage).toMatchObject({ readOnly: true, readOnlyReason: 'plan_full' });
    // a reason added later still reads, and readOnly alone decides
    const later = backupUsageSchema.parse({
      ...(cloudContractFixture('backup/usage-plan-full.json') as object),
      readOnlyReason: 'something_new',
    });
    expect(later).toMatchObject({ readOnly: true, readOnlyReason: 'something_new' });
    // one it cannot read at all still never fails the answer, and stays read-only
    const garbled = backupUsageSchema.parse({
      ...(cloudContractFixture('backup/usage-plan-full.json') as object),
      readOnlyReason: 'x'.repeat(500),
    });
    expect(garbled).toMatchObject({ readOnly: true, readOnlyReason: 'unknown' });
  });

  it('reads a grant that names its read-only reason, and one that does not (FL-301)', () => {
    const grant = cloudContractFixture('backup/grant-response.json') as Record<string, unknown>;
    expect(backupGrantResponseSchema.parse({ ...grant, readOnly: true, readOnlyReason: 'plan_full' })).toMatchObject({
      readOnly: true,
      readOnlyReason: 'plan_full',
    });
    expect(backupGrantResponseSchema.parse(grant).readOnlyReason).toBeUndefined();
  });

  it('reads usage, an escrow record and the agent settings, and checks a run report before it is sent', () => {
    const usage = backupUsageSchema.parse(cloudContractFixture('backup/usage.json'));

    expect(usage).toMatchObject({ readOnly: false, readOnlyReason: null, extraBlocks: 1 });
    expect(keyEscrowRecordSchema.safeParse(cloudContractFixture('backup/escrow-record.json')).success).toBe(true);
    expect(backupAgentSettingsSchema.safeParse(cloudContractFixture('backup/settings.json')).success).toBe(true);
    const report = cloudContractFixture('backup/run-report.json');
    expect(backupRunReportSchema.safeParse(report).success).toBe(true);
    // telemetry never carries a path or free text
    expect(backupRunReportSchema.safeParse({ ...report, manifestKey: '/data/library/a.jpg' }).success).toBe(false);
    expect(backupRunReportSchema.safeParse({ ...report, errorCode: 'Access Denied' }).success).toBe(false);
  });

  it('builds every route from discovery', () => {
    expect(backupEndpoints({ api: 'https://api.frameleaf.test/' })).toEqual({
      locations: 'https://api.frameleaf.test/v2/backup/locations',
      grant: 'https://api.frameleaf.test/v2/backup/grant',
      rotate: 'https://api.frameleaf.test/v2/backup/grant/rotate',
      usage: 'https://api.frameleaf.test/v1/backup/usage',
      runs: 'https://api.frameleaf.test/v1/backup/runs',
      settings: 'https://api.frameleaf.test/v1/backup/settings',
      escrow: 'https://api.frameleaf.test/v1/backup/escrow',
    });
  });

  describe(managedBackupRefusal.name, () => {
    it('stops on a withdrawn grant and says why', () => {
      expect(managedBackupRefusal(cloudError(410, 'errors/grant-revoked.json'))).toEqual({
        message: 'This server was unlinked from Frameleaf Cloud, so its managed backup storage was withdrawn.',
        retry: false,
        retryAfterSeconds: null,
        cloneSuspected: false,
      });
    });

    it('stops on a suspected copy of this server, with a clear message', () => {
      const refusal = managedBackupRefusal(cloudError(409, 'errors/clone-suspected.json'));

      expect(refusal).toMatchObject({ retry: false, cloneSuspected: true });
      expect(refusal.message).toContain('copy of another one');
    });

    it('waits while new backup grants are paused, with Frameleaf Cloud’s own message (FC-62)', () => {
      const paused = new FrameleafCloudError(
        MlAdmissionRefusal.CloudUnavailable,
        503,
        'New backup storage is paused while we add capacity.',
        errorEnvelopeSchema.parse({
          code: 'service-paused',
          message: 'New backup storage is paused while we add capacity.',
          retryable: true,
        }),
        null,
        300,
      );
      expect(managedBackupRefusal(paused)).toEqual({
        message: 'New backup storage is paused while we add capacity.',
        retry: true,
        retryAfterSeconds: 300,
        cloneSuspected: false,
      });
    });

    it('waits out a rate limit for as long as Frameleaf Cloud asks', () => {
      expect(managedBackupRefusal(cloudError(429, 'errors/rate-limited.json'))).toMatchObject({
        retry: true,
        retryAfterSeconds: 1740,
      });
      expect(managedBackupRefusal(cloudError(429, 'errors/rate-limited.json', 60))).toMatchObject({
        retryAfterSeconds: 60,
      });
    });

    it('tries again later when the region has no storage, and stops without a plan or in another key mode', () => {
      expect(managedBackupRefusal(cloudError(409, 'errors/region-unavailable.json'))).toMatchObject({ retry: true });
      expect(managedBackupRefusal(cloudError(402, 'errors/entitlement-missing.json'))).toMatchObject({ retry: false });
      expect(managedBackupRefusal(cloudError(409, 'errors/escrow-not-allowed.json'))).toMatchObject({
        retry: false,
        message: 'Key escrow is only available when this server generates its own backup key.',
      });
    });
  });
});
