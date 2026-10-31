import { SafetyLookupSchema } from 'src/dtos/safety.dto.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';
import { SafetyService } from 'src/services/safety.service.js';
import { factory } from 'test/small.factory.js';

describe(SafetyService.name, () => {
  const auth = factory.auth();
  const at = new Date('2026-09-30T00:00:00Z');
  const hash = 'a'.repeat(64);
  const query = {};
  const integrity = { getSafetyQuery: vi.fn(() => query) };
  const index = { getSafetyAssets: vi.fn(), getSafetySummary: vi.fn() };
  const cloud = { getSafetyAvailability: vi.fn() };
  const sut = new SafetyService(
    integrity as unknown as IntegrityRepository,
    index as unknown as CloudBackupIndexRepository,
    cloud as unknown as CloudBackupService,
  );
  beforeEach(() => {
    vi.clearAllMocks();
    cloud.getSafetyAvailability.mockResolvedValue({ state: 'ready', bucket: 'private-bucket' });
  });

  it('accepts 1000 hashes, normalizes hex and refuses malformed/oversized requests', () => {
    expect(
      SafetyLookupSchema.parse({ hashes: Array.from({ length: 1000 }, () => hash.toUpperCase()) }).hashes,
    ).toHaveLength(1000);
    expect(SafetyLookupSchema.parse({ hashes: [hash.toUpperCase()] }).hashes).toEqual([hash]);
    expect(SafetyLookupSchema.safeParse({ hashes: ['foreign-malformed'] }).success).toBe(false);
    expect(SafetyLookupSchema.safeParse({ hashes: Array.from({ length: 2001 }, () => hash) }).success).toBe(false);
  });

  it('allowlists facts, keeps unknown integrity unknown and does not expose storage settings', async () => {
    index.getSafetyAssets.mockResolvedValue([
      {
        id: auth.user.id,
        sha256: hash,
        deliveredBy: 'icloud-sync:connection',
        onServerSince: at,
        isOffline: false,
        lastIntegrityAt: null,
        integrityResult: null,
        backedUpSince: at,
        lastCompletedAt: at,
        lastVerifiedAt: null,
        endpoint: 'secret',
        keyFingerprint: 'secret',
        bucket: 'secret',
        originalPath: '/secret',
      },
    ]);
    const response = await sut.lookup(auth, { hashes: [hash, hash] });
    expect(integrity.getSafetyQuery).toHaveBeenCalledWith(auth, [hash]);
    expect(index.getSafetyAssets).toHaveBeenCalledWith(query, 'private-bucket');
    expect(response.assets[0]).toEqual({
      id: auth.user.id,
      sha256: hash,
      deliveredBy: 'icloud-sync:connection',
      onServerSince: at.toISOString(),
      lastIntegrityAt: null,
      integrityResult: 'unknown',
      cloudBackup: { state: 'completed', since: at.toISOString(), lastVerifiedRunAt: null },
    });
    expect(JSON.stringify(response)).not.toContain('secret');
  });

  it.each(['off', 'not-linked', 'not-configured'])(
    'reports %s instead of a misleading cloud zero percent',
    async (state) => {
      cloud.getSafetyAvailability.mockResolvedValue({ state, bucket: null });
      index.getSafetySummary.mockResolvedValue({
        total: 4,
        onServer: 3,
        fromICloudSync: 2,
        backedUp: 0,
        lastCompletedAt: null,
        lastVerifiedAt: null,
      });
      expect(await sut.summary(auth)).toEqual({
        cloudAvailability: state,
        total: 4,
        onServer: 3,
        fromICloudSync: 2,
        onServerPercent: 75,
        backedUp: null,
        backedUpPercent: null,
        lastCompletedRunAt: null,
        lastVerifiedRunAt: null,
      });
    },
  );

  it('retains completed proof while a key is paused, without claiming a verification', async () => {
    cloud.getSafetyAvailability.mockResolvedValue({ state: 'paused-key-unloaded', bucket: 'private-bucket' });
    index.getSafetySummary.mockResolvedValue({
      total: 4,
      onServer: 4,
      fromICloudSync: 1,
      backedUp: 3,
      lastCompletedAt: at,
      lastVerifiedAt: null,
    });
    expect(await sut.summary(auth)).toMatchObject({
      cloudAvailability: 'paused-key-unloaded',
      backedUp: 3,
      backedUpPercent: 75,
      lastCompletedRunAt: at.toISOString(),
      lastVerifiedRunAt: null,
    });
  });

  it('reports backups paused for a full plan without hiding what is already backed up (FL-301)', async () => {
    cloud.getSafetyAvailability.mockResolvedValue({
      state: 'ready',
      bucket: 'private-bucket',
      readOnly: true,
      readOnlyReason: 'plan_full',
    });
    index.getSafetySummary.mockResolvedValue({
      total: 4,
      onServer: 4,
      fromICloudSync: 1,
      backedUp: 3,
      lastCompletedAt: at,
      lastVerifiedAt: null,
    });
    index.getSafetyAssets.mockResolvedValue([]);
    expect(await sut.summary(auth)).toMatchObject({
      cloudAvailability: 'ready',
      cloudReadOnly: true,
      cloudReadOnlyReason: 'plan_full',
      backedUp: 3,
    });
    expect(await sut.lookup(auth, { hashes: ['a'.repeat(64)] })).toMatchObject({
      cloudReadOnly: true,
      cloudReadOnlyReason: 'plan_full',
    });
  });

  it('returns no dates or counts for an empty accessible library', async () => {
    index.getSafetySummary.mockResolvedValue({
      total: 0,
      onServer: 0,
      fromICloudSync: 0,
      backedUp: 0,
      lastCompletedAt: null,
      lastVerifiedAt: null,
    });
    expect(await sut.summary(auth)).toMatchObject({
      total: 0,
      onServerPercent: 0,
      backedUpPercent: 0,
      lastCompletedRunAt: null,
      lastVerifiedRunAt: null,
    });
  });
});
