import { MlAdmissionRefusal } from 'src/enum.js';
import { FrameleafCloudBackupRepository } from 'src/repositories/frameleaf-cloud-backup.repository.js';
import { FrameleafCloudError, errorEnvelopeSchema } from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

describe(FrameleafCloudBackupRepository.name, () => {
  const token = { accessToken: 'token', signer: {} } as never;
  const target = { api: 'https://api.frameleaf.test', token };
  let requestJson: ReturnType<typeof vi.fn>;
  let sut: FrameleafCloudBackupRepository;

  beforeEach(() => {
    requestJson = vi.fn().mockResolvedValue({});
    sut = new FrameleafCloudBackupRepository({ requestJson } as never);
  });

  it('asks for the selected location and rotates with an empty body using the instance token', async () => {
    await sut.grant(target, 'loc-07');
    await sut.rotate(target);

    expect(requestJson).toHaveBeenNthCalledWith(1, expect.anything(), {
      method: 'POST',
      url: 'https://api.frameleaf.test/v2/backup/grant',
      dpop: token,
      body: { locationId: 'loc-07' },
    });
    expect(requestJson).toHaveBeenNthCalledWith(2, expect.anything(), {
      method: 'POST',
      url: 'https://api.frameleaf.test/v2/backup/grant/rotate',
      dpop: token,
      body: {},
    });
  });

  it('fetches authenticated locations and recorded metadata and treats only not-found as an unclaimed server', async () => {
    await sut.locations(target);
    await sut.metadata(target);
    expect(requestJson.mock.calls.map(([, options]) => [options.url, options.dpop])).toEqual([
      ['https://api.frameleaf.test/v2/backup/locations', token],
      ['https://api.frameleaf.test/v2/backup/grant', token],
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
    expect(() => sut.grant(target, 'https://outside.example')).toThrow();
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
});
