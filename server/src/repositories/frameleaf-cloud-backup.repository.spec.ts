import { FrameleafCloudBackupRepository } from 'src/repositories/frameleaf-cloud-backup.repository.js';
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

  it('asks for the grant and its rotation with an empty body and the instance token', async () => {
    await sut.grant(target);
    await sut.rotate(target);

    expect(requestJson).toHaveBeenNthCalledWith(1, expect.anything(), {
      method: 'POST',
      url: 'https://api.frameleaf.test/v1/backup/grant',
      dpop: token,
      body: {},
    });
    expect(requestJson).toHaveBeenNthCalledWith(2, expect.anything(), {
      method: 'POST',
      url: 'https://api.frameleaf.test/v1/backup/grant/rotate',
      dpop: token,
      body: {},
    });
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
