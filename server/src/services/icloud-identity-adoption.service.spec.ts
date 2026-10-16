import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ICloudIdentityAdoptionRepository,
  IdentityAdoptionEvidence,
} from 'src/repositories/icloud-identity-adoption.repository.js';
import { AssetType, ChecksumAlgorithm } from 'src/enum.js';
import { ICloudIdentityAdoptionService } from 'src/services/icloud-identity-adoption.service.js';
vi.mock('src/services/icloud-identity.service.js', () => ({ identityMatchingEnabled: () => true }));
vi.mock('src/repositories/icloud-weekly-adoption-authority.js', () => ({ weeklyIdentityAdoptionActive: () => true }));

describe('identity adoption owned-file lifetime', () => {
  const authority = {
    ownerId: 'owner',
    connectionId: 'connection',
    config: '{}',
    operationId: 'operation',
    operationClaimToken: 'operation-token',
    resourceId: 'resource',
    resourceLeaseToken: 'resource-token',
  };
  const fixtures: {
    directory: string;
    result: PromiseWithResolvers<{ status: 'healthy' | 'unsupported' }>;
    settled: PromiseWithResolvers<void>;
    tasks: Promise<unknown>[];
    sut: ICloudIdentityAdoptionService;
  }[] = [];
  async function fixture() {
    vi.stubEnv('FRAMELEAF_ICLOUD_IDENTITY_ADOPTION', 'true');
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-adoption-lifetime-'));
    const originalPath = join(directory, 'original.jpg');
    const bytes = Buffer.from('owned validation bytes');
    await writeFile(originalPath, bytes);
    const result = Promise.withResolvers<{ status: 'healthy' | 'unsupported' }>();
    const settled = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let copyPath = '';
    let evidence: IdentityAdoptionEvidence | undefined;
    const candidate = {
      identityId: 'identity',
      assetId: 'asset',
      sha256: createHash('sha256').update(bytes).digest(),
      originalPath,
      originalFileName: 'original.jpg',
      type: AssetType.Image,
      checksum: createHash('sha256').update(bytes).digest(),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      updateId: 'update',
      physicalId: null,
      cplMasterRecordName: 'master',
      cloudIdentifier: 'cloud',
      libraryKey: 'private',
    };
    const repository = {
      adopt: vi.fn<ICloudIdentityAdoptionRepository['adopt']>().mockImplementation(async (_authority, verify) => {
        const verified = await verify(candidate);
        if (verified === 'miss') return 'miss';
        if (!verified) return 'retry';
        evidence = verified;
        return (await verified.current()) ? 'adopted' : 'retry';
      }),
    };
    const integrity = {
      validateWithSettlement: vi.fn((input: { path: string }) => {
        copyPath = input.path;
        started.resolve();
        return { result: result.promise, settled: settled.promise };
      }),
    };
    const sut = new ICloudIdentityAdoptionService(repository as never, integrity as never);
    const tasks: Promise<unknown>[] = [];
    const f = {
      directory,
      originalPath,
      bytes,
      result,
      settled,
      started,
      repository,
      integrity,
      sut,
      tasks,
      copyPath: () => copyPath,
      evidence: () => evidence,
      start: () => {
        const task = sut.adopt(authority);
        tasks.push(task);
        return task;
      },
    };
    fixtures.push(f);
    return f;
  }
  afterEach(async () => {
    for (const f of fixtures.splice(0)) {
      f.result.resolve({ status: 'healthy' });
      f.settled.resolve();
      await Promise.allSettled(f.tasks);
      await f.sut.onShutdown();
      await rm(f.directory, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  it.each(['healthy', 'unsupported'] as const)(
    'waits for a producer returning %s and refuses new work after shutdown starts',
    async (status) => {
      const f = await fixture();
      const adoption = f.start();
      await f.started.promise;
      let finished = false;
      const shutdown = f.sut.onShutdown().then(() => {
        finished = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(finished).toBe(false);
      f.result.resolve({ status });
      f.settled.resolve();
      await expect(adoption).resolves.toBe('retry');
      await shutdown;
      await expect(stat(f.copyPath())).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(f.originalPath)).toEqual(f.bytes);
    },
  );

  it('refuses new producers after shutdown without allocating a copy or calling the repository', async () => {
    const f = await fixture();
    await f.sut.onShutdown();
    f.result.resolve({ status: 'healthy' });
    f.settled.resolve();
    await expect(f.start()).resolves.toBe('retry');
    expect(f.repository.adopt).not.toHaveBeenCalled();
    expect(f.integrity.validateWithSettlement).not.toHaveBeenCalled();
  });

  it('keeps a noncooperative decoder input until settlement and waits for cleanup after producer refusal', async () => {
    const f = await fixture();
    const adoption = f.start();
    await f.started.promise;
    let finished = false;
    const shutdown = f.sut.onShutdown().then(() => {
      finished = true;
    });
    f.result.reject(new Error('decode deadline'));
    await expect(adoption).resolves.toBe('retry');
    expect(finished).toBe(false);
    expect(await readFile(f.copyPath())).toEqual(f.bytes);
    f.settled.resolve();
    await shutdown;
    await expect(stat(f.copyPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('settles failed producers so shutdown does not retain a dead operation', async () => {
    const f = await fixture();
    f.repository.adopt.mockRejectedValueOnce(new Error('authority retired'));
    await expect(f.start()).resolves.toBe('retry');
    await expect(f.sut.onShutdown()).resolves.toBeUndefined();
    expect(f.integrity.validateWithSettlement).not.toHaveBeenCalled();
  });

  it('preserves disabled adoption as a miss without entering the repository', async () => {
    const f = await fixture();
    vi.stubEnv('FRAMELEAF_ICLOUD_IDENTITY_ADOPTION', 'false');
    await expect(f.start()).resolves.toBe('miss');
    expect(f.repository.adopt).not.toHaveBeenCalled();
  });

  it('retains successful same-file byte evidence and removes only the owned validation copy', async () => {
    const f = await fixture();
    f.result.resolve({ status: 'healthy' });
    f.settled.resolve();
    await expect(f.start()).resolves.toBe('adopted');
    expect(f.evidence()!.sha256).toEqual(createHash('sha256').update(f.bytes).digest());
    expect(f.evidence()!.sizeInBytes).toBe(f.bytes.length);
    await f.sut.onShutdown();
    expect(await readFile(f.originalPath)).toEqual(f.bytes);
    await expect(stat(f.copyPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
