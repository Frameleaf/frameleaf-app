import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaOperationDestination, MediaOperationKind, RenderWorkerAuditEvent, RenderWorkerStatus } from 'src/enum.js';
import { RenderWorker } from 'src/repositories/render-worker.repository.js';
import { BundledRenderWorkerService } from 'src/services/bundled-render-worker.service.js';
import { BUNDLED_RENDER_WORKER_APPROVAL } from 'src/utils/bundled-render-worker.js';
import { STUDIO_ENGINE_REVISION } from 'src/utils/studio-commands.generated.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const bundled = (overrides: Partial<RenderWorker> = {}) =>
  ({
    id: '0195e2a0-0000-7000-8000-00000000b001',
    name: 'Studio worker (machine learning)',
    destination: MediaOperationDestination.Local,
    status: RenderWorkerStatus.Active,
    kinds: [MediaOperationKind.StudioExport],
    gpuWorkingBudgetApproval: BUNDLED_RENDER_WORKER_APPROVAL,
    ...overrides,
  }) as unknown as RenderWorker;

describe(BundledRenderWorkerService.name, () => {
  let sut: BundledRenderWorkerService;
  let mocks: ServiceMocks;
  let trustDir: string;

  beforeEach(async () => {
    ({ sut, mocks } = newTestService(BundledRenderWorkerService));
    trustDir = join(await mkdtemp(join(tmpdir(), 'fl408-trust-')), 'studio-worker');
    mocks.config.getEnv.mockReturnValue(mockEnvData({ studioWorker: { enabled: true, trustDir } }));
    mocks.crypto.randomBytesAsText.mockReturnValue('fresh-secret');
    mocks.renderWorker.listWorkers.mockResolvedValue([]);
    mocks.renderWorker.createWorker.mockImplementation((worker) =>
      Promise.resolve(bundled({ ...(worker as Partial<RenderWorker>), id: '0195e2a0-0000-7000-8000-00000000b002' })),
    );
    mocks.renderWorker.setEnrolmentSecret.mockResolvedValue(true);
  });

  afterEach(async () => {
    await rm(join(trustDir, '..'), { recursive: true, force: true });
  });

  const readTrust = async () => JSON.parse(await readFile(join(trustDir, 'enrolment.json'), 'utf8'));

  it('does nothing when the bundled worker is turned off', async () => {
    mocks.config.getEnv.mockReturnValue(mockEnvData({ studioWorker: { enabled: false, trustDir } }));
    await expect(sut.ensureEnrolment()).resolves.toBe('disabled');
    expect(mocks.renderWorker.listWorkers).not.toHaveBeenCalled();
    expect(mocks.renderWorker.createWorker).not.toHaveBeenCalled();
  });

  it('enrols one local Studio export worker with the server-written trust marker and writes its enrolment privately', async () => {
    await expect(sut.ensureEnrolment()).resolves.toBe('enrolled');
    expect(mocks.renderWorker.createWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: MediaOperationDestination.Local,
        kinds: [MediaOperationKind.StudioExport],
        maxConcurrentOperations: 1,
        engineDigest: STUDIO_ENGINE_REVISION,
        enrolmentSecret: Buffer.from('fresh-secret (hashed)'),
        gpuWorkingBudgetApproval: BUNDLED_RENDER_WORKER_APPROVAL,
        createdBy: null,
      }),
    );
    expect(mocks.renderWorker.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: RenderWorkerAuditEvent.Enrolled,
        detail: expect.objectContaining({ bundled: true }),
      }),
    );
    await expect(readTrust()).resolves.toEqual({
      version: 1,
      workerId: '0195e2a0-0000-7000-8000-00000000b002',
      enrolmentSecret: 'fresh-secret',
    });
    expect((await stat(join(trustDir, 'enrolment.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(trustDir)).mode & 0o077).toBe(0);
  });

  it('rotates the secret of the existing bundled worker on every start instead of enrolling another', async () => {
    mocks.renderWorker.listWorkers.mockResolvedValue([bundled()]);
    await expect(sut.ensureEnrolment()).resolves.toBe('enrolled');
    expect(mocks.renderWorker.createWorker).not.toHaveBeenCalled();
    expect(mocks.renderWorker.setEnrolmentSecret).toHaveBeenCalledWith(
      '0195e2a0-0000-7000-8000-00000000b001',
      Buffer.from('fresh-secret (hashed)'),
    );
    await expect(readTrust()).resolves.toMatchObject({ workerId: '0195e2a0-0000-7000-8000-00000000b001' });
    // pinned to this server's Studio engine when it was enrolled on another one
    expect(mocks.renderWorker.updateWorker).toHaveBeenCalledWith('0195e2a0-0000-7000-8000-00000000b001', {
      engineDigest: STUDIO_ENGINE_REVISION,
    });
  });

  it('leaves an already pinned bundled worker alone', async () => {
    mocks.renderWorker.listWorkers.mockResolvedValue([bundled({ engineDigest: STUDIO_ENGINE_REVISION })]);
    await expect(sut.ensureEnrolment()).resolves.toBe('enrolled');
    expect(mocks.renderWorker.updateWorker).not.toHaveBeenCalled();
  });

  it('ignores administrator-enrolled workers when looking for the bundled one', async () => {
    mocks.renderWorker.listWorkers.mockResolvedValue([bundled({ id: 'admin', gpuWorkingBudgetApproval: null })]);
    await expect(sut.ensureEnrolment()).resolves.toBe('enrolled');
    expect(mocks.renderWorker.createWorker).toHaveBeenCalledOnce();
  });

  it('keeps a bundled worker an administrator revoked revoked', async () => {
    mocks.renderWorker.listWorkers.mockResolvedValue([bundled({ status: RenderWorkerStatus.Revoked })]);
    await expect(sut.ensureEnrolment()).resolves.toBe('revoked');
    expect(mocks.renderWorker.createWorker).not.toHaveBeenCalled();
    expect(mocks.renderWorker.setEnrolmentSecret).not.toHaveBeenCalled();
    await expect(readTrust()).rejects.toThrow();
  });

  it('reports the trust volume as unavailable when it cannot be written', async () => {
    const file = join(trustDir, '..', 'not-a-directory');
    await writeFile(file, '');
    mocks.config.getEnv.mockReturnValue(mockEnvData({ studioWorker: { enabled: true, trustDir: join(file, 'x') } }));
    await expect(sut.ensureEnrolment()).resolves.toBe('unavailable');
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it('never fails server start when enrolment throws', async () => {
    mocks.renderWorker.listWorkers.mockRejectedValue(new Error('database down'));
    await expect(sut.onBootstrap()).resolves.toBeUndefined();
    expect(mocks.logger.warn).toHaveBeenCalled();
  });
});
