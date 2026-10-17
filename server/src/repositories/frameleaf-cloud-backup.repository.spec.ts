import type { BackupSnapshotRecord } from 'src/utils/cloud-backup-recovery.js';
import { MlAdmissionRefusal } from 'src/enum.js';
import { FrameleafCloudBackupRepository } from 'src/repositories/frameleaf-cloud-backup.repository.js';
import { backupRecoveryPackageSchema } from 'src/utils/cloud-backup-recovery.js';
import { FrameleafCloudError, errorEnvelopeSchema } from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

describe(FrameleafCloudBackupRepository.name, () => {
  const token = { accessToken: 'token', signer: {} } as never;
  const target = { api: 'https://api.frameleaf.test', token };
  let requestJson: ReturnType<typeof vi.fn>;
  let requestJsonTimed: ReturnType<typeof vi.fn>;
  let sut: FrameleafCloudBackupRepository;

  beforeEach(() => {
    requestJson = vi.fn().mockResolvedValue({});
    requestJsonTimed = vi
      .fn()
      .mockResolvedValue({ data: {}, serverTime: Date.parse('2026-10-11T12:00:00Z'), elapsedMs: 0 });
    sut = new FrameleafCloudBackupRepository({ requestJson, requestJsonTimed } as never);
  });

  it('asks for the selected location and renews the requested operation using the instance token', async () => {
    await sut.grant(target, 'loc-07', 'upload');
    await sut.rotate(target, 'restore');

    expect(requestJsonTimed).toHaveBeenNthCalledWith(1, expect.anything(), {
      method: 'POST',
      url: 'https://api.frameleaf.test/v4/backup/grant',
      dpop: token,
      body: { locationId: 'loc-07', operation: 'upload' },
    });
    expect(requestJsonTimed).toHaveBeenNthCalledWith(2, expect.anything(), {
      method: 'POST',
      url: 'https://api.frameleaf.test/v4/backup/grant/rotate',
      dpop: token,
      body: { operation: 'restore' },
    });
  });

  it('fetches authenticated locations and recorded metadata and treats only not-found as an unclaimed server', async () => {
    await sut.locations(target);
    await sut.metadata(target);
    expect(requestJson.mock.calls.map(([, options]) => [options.url, options.dpop])).toEqual([
      ['https://api.frameleaf.test/v4/backup/locations', token],
      ['https://api.frameleaf.test/v4/backup/grant', token],
    ]);
    requestJson.mockRejectedValue(
      new FrameleafCloudError(
        MlAdmissionRefusal.CloudUnavailable,
        404,
        'missing',
        errorEnvelopeSchema.parse({ code: 'not-found', message: 'missing', retryable: false }),
      ),
    );
    await expect(sut.metadata(target)).resolves.toBeNull();
    requestJson.mockRejectedValue(new Error('connection failed'));
    await expect(sut.metadata(target)).rejects.toThrow('connection failed');
  });

  it('refuses an invalid location ID before sending any provisioning request', () => {
    expect(() => sut.grant(target, 'https://outside.example', 'upload')).toThrow();
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('puts the settings and the escrow blob, and deletes the escrow', async () => {
    await sut.putSettings(target, { keyMode: 'server', scheduleEnabled: true });
    await sut.putEscrow(target, cloudContractFixture('backup/escrow-blob.json'));
    await sut.deleteEscrow(target);

    expect(requestJson.mock.calls.map(([, request]) => [request.method, request.url])).toEqual([
      ['PUT', 'https://api.frameleaf.test/v1/backup/settings'],
      ['PUT', 'https://api.frameleaf.test/v1/backup/escrow'],
      ['DELETE', 'https://api.frameleaf.test/v1/backup/escrow'],
    ]);
  });

  it('never sends a run report or an escrow blob the contract would refuse', async () => {
    const report = cloudContractFixture('backup/run-report.json');

    await expect(sut.reportRun(target, { ...report, manifestKey: '/data/library/secret.jpg' })).rejects.toThrow();
    await expect(
      sut.putEscrow(target, {
        ...cloudContractFixture<Record<string, unknown>>('backup/escrow-blob.json'),
        key: 'plaintext',
      } as never),
    ).rejects.toThrow();
    expect(requestJson).not.toHaveBeenCalled();

    await sut.reportRun(target, report);
    expect(requestJson).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: report }));
  });

  it('sends only the v2 signed descriptor and wrapped package, and deletes every package for that vault', async () => {
    const vaultId = 'f0000000-0000-4000-8000-000000000001';
    const record: BackupSnapshotRecord = {
      descriptor: {
        version: 2,
        instanceId: vaultId,
        vaultId,
        snapshotId: 'f0000000-0000-4000-8000-000000000002',
        sequence: 1,
        previousDigest: null,
        createdAt: '2026-10-11T00:00:00.000Z',
        signerKid: 'A'.repeat(43),
        manifest: {
          format: 'frameleaf-client-backup',
          formatVersion: 1,
          keyVersion: 1,
          objectKey: `m/v1/${vaultId}/1/20261011T000001Z.json.gz`,
          versionId: 'exact-version',
          ciphertextSha256: 'b'.repeat(64),
        },
      },
      signature: 'A'.repeat(86),
      digest: 'c'.repeat(64),
      signerJwk: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), kid: 'A'.repeat(43) },
      receivedAt: '2026-10-11T00:00:00.000Z',
    };
    await sut.reportSnapshot(target, record);
    expect(requestJson.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      url: 'https://api.frameleaf.test/v2/backup/snapshots',
      body: { descriptor: record.descriptor, signature: record.signature },
    });
    expect(Object.keys(requestJson.mock.calls[0][1].body)).toEqual(['descriptor', 'signature']);
    const blob = backupRecoveryPackageSchema.parse({
      ...cloudContractFixture<Record<string, unknown>>('backup/escrow-blob.json'),
      version: 2,
      vaultId,
      keyVersion: 1,
    });
    await sut.putRecoveryPackage(target, blob);
    await expect(sut.putRecoveryPackage(target, { ...blob, plaintextKey: 'secret' } as never)).rejects.toThrow();
    requestJson.mockResolvedValueOnce({ packages: [{ ...blob, updatedAt: '2026-10-11T00:00:00.000Z' }] });
    await sut.deleteRecoveryPackages(target, vaultId);
    expect(requestJson.mock.calls.at(-1)![1]).toMatchObject({
      method: 'DELETE',
      url: `https://api.frameleaf.test/v2/backup/escrow?vaultId=${vaultId}&keyVersion=1`,
    });
  });

  it.each([null, '2026-10-11T11:59:59Z', '2026-10-11T12:00:20Z', '2026-10-11T12:30:00Z'])(
    'refuses absent server time or unusable provider expiry %s',
    async (expiry) => {
      const data = cloudContractFixture('backup/capability-upload.json');
      if (expiry) data.capability.expiresAt = expiry;
      requestJsonTimed.mockResolvedValue({
        data,
        serverTime: expiry ? Date.parse('2026-10-11T12:00:00Z') : NaN,
        elapsedMs: 0,
      });
      await expect(sut.rotate(target, 'upload')).rejects.toThrow('unusable temporary backup lifetime');
    },
  );

  it('uses authenticated server time and accounts for response delay instead of client wall clock', async () => {
    const data = cloudContractFixture('backup/capability-upload.json');
    data.capability.expiresAt = '2026-10-11T12:02:00Z';
    requestJsonTimed.mockResolvedValue({ data, serverTime: Date.parse('2026-10-11T12:00:00Z'), elapsedMs: 10_000 });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      expect((await sut.rotate(target, 'upload')).capability.refreshAfterSec).toBe(80);
    } finally {
      clock.mockRestore();
    }
  });
});
