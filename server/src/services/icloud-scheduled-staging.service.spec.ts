import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetType } from 'src/enum.js';
import { ICloudScheduledStagingService } from 'src/services/icloud-scheduled-staging.service.js';
import {
  ValidationInputEnvelope,
  ValidationInputPayload,
  ValidationInputState,
  validationInputScope,
  validationInputsScope,
} from 'src/utils/icloud-private-copy.js';
import { canonicalJson } from 'src/utils/studio-project.js';

vi.mock('node:fs/promises', { spy: true });

describe('scheduled publication handle closure', () => {
  it.each([false, true])('settles every owned close before release (close failure: %s)', async (failedClose) => {
    const directory = await mkdtemp(join(tmpdir(), 'scheduled-close-'));
    const path = join(directory, 'fresh');
    const originalPath = join(directory, 'original');
    await writeFile(path, 'fresh', { mode: 0o600 });
    await writeFile(originalPath, 'original', { mode: 0o600 });
    const input = { ownerId: 'owner', resource: { id: 'resource', leaseToken: 'lease' }, authority: {} } as never;
    const validation = { payload: { path } };
    const repository = {
      beginPrivateWork: vi.fn().mockResolvedValue('owned-work'),
      authenticateDeepValidation: vi.fn().mockResolvedValue(true),
      finishPrivateWork: vi.fn().mockResolvedValue(undefined),
    };
    const sut = new ICloudScheduledStagingService(repository as never, {} as never, {} as never, {} as never);
    const admission = sut as unknown as {
      directory: () => Promise<unknown>;
      cached: () => Promise<unknown>;
      checkpoint: () => Promise<unknown>;
    };
    vi.spyOn(admission, 'directory').mockResolvedValue({ directory, path });
    vi.spyOn(admission, 'cached').mockResolvedValue({ payload: { identity: await stat(path) } });
    vi.spyOn(admission, 'checkpoint').mockResolvedValue({
      guarded: {
        bindings: { receipt: { snapshot: { fileIdentity: await stat(originalPath) } }, original: { originalPath } },
      },
      resource: { verification: { auditDeepValidation: validation } },
    });
    const files = await sut.holdPublicationFiles(input);
    const handles = (await Promise.all(
      vi
        .mocked(open)
        .mock.results.slice(-2)
        .map((result) => result.value),
    )) as { close: () => Promise<void> }[];
    const close = handles.map((handle) => handle.close.bind(handle));
    const held = Promise.withResolvers<void>();
    const firstSettled = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const secondSettled = Promise.withResolvers<void>();
    const firstClosing = vi.spyOn(handles[0], 'close').mockImplementation(async () => {
      await close[0]();
      firstSettled.resolve();
      if (failedClose) throw new Error('controlled owned handle close failure');
    });
    const secondClosing = vi.spyOn(handles[1], 'close').mockImplementation(async () => {
      secondStarted.resolve();
      await held.promise;
      await close[1]();
      secondSettled.resolve();
    });
    let released = false;
    const release = files
      .release()
      .then(() => {
        released = true;
      })
      .catch((error: unknown) => {
        released = true;
        return error;
      });
    try {
      await Promise.all([firstSettled.promise, secondStarted.promise]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(released).toBe(false);
      expect(repository.finishPrivateWork).not.toHaveBeenCalled();
    } finally {
      held.resolve();
      await Promise.all([release, secondSettled.promise]);
      firstClosing.mockRestore();
      secondClosing.mockRestore();
      await sut.onShutdown();
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
    if (failedClose) {
      expect(await release).toBeInstanceOf(Error);
      expect(repository.finishPrivateWork).not.toHaveBeenCalled();
    } else {
      expect(await release).toBeUndefined();
      expect(repository.finishPrivateWork).toHaveBeenCalledWith(input, 'owned-work');
    }
  });
});

// These causal regressions remain RED until the approved Tasks 4/5 service integration.
describe('validation input accounting baseline', () => {
  async function fixture(destinationValidation = false) {
    const directory = await mkdtemp(join(tmpdir(), 'validation-input-'));
    const path = join(directory, 'complete');
    await writeFile(path, 'fresh', { mode: 0o600 });
    const destination = destinationValidation ? join(directory, 'recovery') : undefined;
    if (destination) await writeFile(destination, 'fresh', { mode: 0o600 });
    const receipt = {
      payload: {
        identity: await stat(path),
        path,
        binding: { sizeInBytes: 5 },
        sha1: createHash('sha1').update('fresh').digest('hex'),
        sha256: createHash('sha256').update('fresh').digest('hex'),
      },
      seal: 'fresh',
    };
    const input = { ownerId: 'owner', resource: { id: 'resource', leaseToken: 'lease' }, authority: {} } as never;
    const repository = {
      beginPrivateWork: vi.fn(() => Promise.resolve(randomUUID())),
      validationInputs: vi.fn().mockResolvedValue(undefined),
      privateCopy: vi.fn().mockResolvedValue(undefined),
      planValidationInput: vi.fn().mockResolvedValue(undefined),
      storeValidationInput: vi.fn((_input, expected, payload) =>
        Promise.resolve({
          ...expected,
          payload: { ...expected.payload, current: { payload, seal: 'input' } },
        }),
      ),
      finishPrivateWork: vi.fn(),
      disposeValidationInput: vi.fn(async (_input, envelope) => {
        await unlink(envelope.payload.current.payload.inputPath);
        await rmdir(envelope.payload.current.payload.directoryPath);
        return true;
      }),
      storeDeepValidation: vi.fn().mockResolvedValue(true),
    };
    const decoderDone = Promise.withResolvers<void>();
    const integrity = {
      validateWithSettlement: vi.fn().mockReturnValue({
        result: Promise.resolve({
          status: 'healthy',
          sha1: Buffer.from(receipt.payload.sha1, 'hex'),
          sha256: Buffer.from(receipt.payload.sha256, 'hex'),
          sizeInBytes: 5,
        }),
        settled: decoderDone.promise,
        cancel: vi.fn(),
      }),
    };
    const sut = new ICloudScheduledStagingService(
      repository as never,
      {} as never,
      { encodeSession: vi.fn().mockResolvedValue('deep') } as never,
      integrity as never,
    );
    const admission = sut as unknown as {
      directory: () => Promise<unknown>;
      cached: () => Promise<unknown>;
      checkpoint: () => Promise<unknown>;
    };
    vi.spyOn(admission, 'directory').mockResolvedValue({ directory, path });
    const cached = vi.spyOn(admission, 'cached').mockResolvedValue(receipt);
    vi.spyOn(admission, 'checkpoint').mockResolvedValue({
      resource: { id: 'resource', expectedSize: 5, source: { type: AssetType.Image, originalFileName: 'input.jpg' } },
    });
    const admit = () =>
      repository.planValidationInput.mockImplementation((_input, plan) =>
        Promise.resolve({
          payload: {
            highWater: '1',
            current: {
              payload: {
                ...plan,
                sequence: '1',
                pathNonce: plan.pathNonce,
                directoryPath: join(directory, '.validation-' + plan.pathNonce),
                inputPath: join(directory, '.validation-' + plan.pathNonce, 'input'),
                state: 'reserved',
                pending: [],
                directoryIdentity: null,
                inputIdentity: null,
                reservedInputBytes: 5,
              },
              seal: 'input',
            },
            previousDisposed: null,
          },
          seal: 'envelope',
        }),
      );
    return { directory, destination, input, repository, integrity, decoderDone, sut, cached, receipt, admit };
  }

  it.each([
    ['source', false],
    ['recovery-destination', true],
  ] as const)(
    'validation input refuses before copying %s when reservation is refused',
    async (_stage, destinationValidation) => {
      const f = await fixture(destinationValidation);
      let validation;
      try {
        let refused = false;
        try {
          validation = await f.sut.validate(f.input, undefined, f.destination);
        } catch {
          refused = true;
        }
        expect(f.integrity.validateWithSettlement).not.toHaveBeenCalled();
        expect((await readdir(f.directory)).filter((name) => name.startsWith('.validation-'))).toEqual([]);
        expect(refused).toBe(true);
      } finally {
        f.decoderDone.resolve();
        await validation?.settled;
        await f.sut.onShutdown();
        vi.restoreAllMocks();
        await rm(f.directory, { recursive: true, force: true });
      }
    },
  );

  it('keeps ordinary final readonly refusal unavailable with successful settlement', async () => {
    const f = await fixture();
    f.admit();
    f.cached
      .mockImplementationOnce(() => Promise.resolve(f.receipt))
      .mockRejectedValueOnce(new Error('ordinary receipt refusal'));
    const validation = await f.sut.validate(f.input);
    try {
      f.decoderDone.resolve();
      expect(await validation.result).toEqual({ status: 'unavailable' });
      await expect(validation.settled).resolves.toBeUndefined();
      expect(f.repository.finishPrivateWork).toHaveBeenCalledTimes(2);
    } finally {
      f.decoderDone.resolve();
      await validation.settled;
      await f.sut.onShutdown();
      vi.restoreAllMocks();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it.each(['cached', 'destination'] as const)(
    'retains final %s readonly close failure through abort, shutdown and cleanup',
    async (stage) => {
      const f = await fixture(stage === 'destination');
      f.admit();
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const read = f.sut as unknown as { readOwned: (...args: unknown[]) => Promise<unknown> };
      if (stage === 'cached') {
        f.cached
          .mockImplementationOnce(() => Promise.resolve(f.receipt))
          .mockImplementationOnce(async () => {
            await read.readOwned(f.input, f.receipt.payload.path);
            return f.receipt;
          });
      }
      const controller = new AbortController();
      const validation = await f.sut.validate(f.input, controller.signal, f.destination);
      const inputState = f.repository.storeValidationInput.mock.results.at(-1)!.value;
      f.repository.validationInputs.mockImplementation(async () => {
        const latest = f.repository.storeValidationInput.mock.results.at(-1)?.value;
        return latest ? await latest : await inputState;
      });
      f.repository.disposeValidationInput.mockImplementation((_input, envelope) =>
        Promise.resolve(envelope.payload.current.payload.state === 'settled'),
      );
      const disposePrivateCopy = vi.fn();
      const disposeRefusedStaging = vi.fn();
      Object.assign(f.repository, { disposePrivateCopy, disposeRefusedStaging });
      const closeStarted = Promise.withResolvers<void>();
      const releaseClose = Promise.withResolvers<void>();
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
          closeStarted.resolve();
          await releaseClose.promise;
          await close();
          throw new Error('controlled final readonly close failure');
        });
        return handle;
      });
      const settlement = validation.settled.catch((error: unknown) => error);
      let stopped = false;
      let shutdown: Promise<void> | undefined;
      try {
        f.decoderDone.resolve();
        await closeStarted.promise;
        controller.abort();
        expect(await validation.result).toEqual({ status: 'unavailable' });
        shutdown = f.sut.onShutdown().then(() => {
          stopped = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(stopped).toBe(false);
        expect(f.repository.finishPrivateWork).toHaveBeenCalledTimes(1);
        releaseClose.resolve();
        expect(await settlement).toBeInstanceOf(Error);
        await shutdown;
        expect(f.repository.storeValidationInput.mock.calls.some((call) => call[2].state === 'settled')).toBe(false);
        expect(f.repository.disposeValidationInput).not.toHaveBeenCalled();
        expect(f.repository.finishPrivateWork).toHaveBeenCalledTimes(1);
        await f.sut.cleanupRetired(f.input);
        expect(disposePrivateCopy).not.toHaveBeenCalled();
        expect(disposeRefusedStaging).not.toHaveBeenCalled();
        expect((await readdir(f.directory)).some((name) => name.startsWith('.validation-'))).toBe(true);
      } finally {
        releaseClose.resolve();
        f.decoderDone.resolve();
        await settlement;
        await shutdown;
        await f.sut.onShutdown();
        vi.restoreAllMocks();
        await rm(f.directory, { recursive: true, force: true });
      }
    },
  );

  it('validation input remains present while final readonly work is unsettled', async () => {
    const f = await fixture();
    f.admit();
    const readonlyDone = Promise.withResolvers<void>();
    const readonlyStarted = Promise.withResolvers<void>();
    f.cached
      .mockImplementationOnce(() => Promise.resolve(f.receipt))
      .mockImplementationOnce(async () => {
        readonlyStarted.resolve();
        await readonlyDone.promise;
        return f.receipt;
      });
    const validation = await f.sut.validate(f.input);
    const copyDirectory = (await readdir(f.directory)).find((name) => name.startsWith('.validation-'))!;
    let settled = false;
    void validation.settled.then(() => {
      settled = true;
    });
    try {
      f.decoderDone.resolve();
      await readonlyStarted.promise;
      await Promise.all(vi.mocked(rm).mock.results.map((result) => result.value));
      validation.cancel();
      expect(await validation.result).toEqual({ status: 'unavailable' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(f.repository.finishPrivateWork).toHaveBeenCalledTimes(1);
      expect(
        await stat(join(f.directory, copyDirectory, 'input'))
          .then(() => true)
          .catch(() => false),
      ).toBe(true);
    } finally {
      readonlyDone.resolve();
      f.decoderDone.resolve();
      await validation.settled;
      await f.sut.onShutdown();
      vi.restoreAllMocks();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
  it.each(['preparing', 'running', 'settled', 'disposal'] as const)(
    'validation input retains custody when %s persistence refuses',
    async (failure) => {
      const f = await fixture();
      f.admit();
      f.decoderDone.resolve();
      const store = f.repository.storeValidationInput.getMockImplementation()!;
      f.repository.storeValidationInput.mockImplementation(async (...args) =>
        args[2].state === failure ? undefined : store(...args),
      );
      if (failure === 'disposal') f.repository.disposeValidationInput.mockResolvedValue(false);
      let validation;
      try {
        if (failure === 'preparing' || failure === 'running') {
          await expect(f.sut.validate(f.input)).rejects.toThrow('scheduled_audit_unavailable');
          expect(f.integrity.validateWithSettlement).not.toHaveBeenCalled();
        } else {
          validation = await f.sut.validate(f.input);
          await expect(validation.settled).rejects.toThrow();
        }
        expect(f.repository.finishPrivateWork).toHaveBeenCalledTimes(1);
        const entries = (await readdir(f.directory)).filter((name) => name.startsWith('.validation-'));
        expect(entries).toHaveLength(1);
        expect(await stat(join(f.directory, entries[0], 'input'))).toBeDefined();
      } finally {
        f.decoderDone.resolve();
        await validation?.settled.catch(() => {});
        await f.sut.onShutdown();
        vi.restoreAllMocks();
        await rm(f.directory, { recursive: true, force: true });
      }
    },
  );

  it('validation input shutdown started during preparation waits for the later decoder settlement', async () => {
    const f = await fixture();
    f.admit();
    const readonlyStarted = Promise.withResolvers<void>();
    const readonlyDone = Promise.withResolvers<void>();
    f.cached.mockImplementationOnce(async () => {
      readonlyStarted.resolve();
      await readonlyDone.promise;
      return f.receipt;
    });
    const preparing = f.sut.validate(f.input);
    await readonlyStarted.promise;
    let shutdownSettled = false;
    const shutdown = f.sut.onShutdown().then(() => {
      shutdownSettled = true;
    });
    try {
      readonlyDone.resolve();
      await preparing;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(shutdownSettled).toBe(false);
      f.decoderDone.resolve();
      await shutdown;
      expect((await readdir(f.directory)).filter((name) => name.startsWith('.validation-'))).toEqual([]);
    } finally {
      readonlyDone.resolve();
      f.decoderDone.resolve();
      await (
        await preparing
      ).settled;
      await shutdown;
      vi.restoreAllMocks();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it('validation input refuses reservation when preliminary settlement cannot persist', async () => {
    const f = await fixture();
    f.admit();
    f.repository.finishPrivateWork.mockRejectedValueOnce(new Error('preliminary settlement refused'));
    try {
      await expect(f.sut.validate(f.input)).rejects.toThrow('scheduled_audit_unavailable');
      expect(f.repository.planValidationInput).not.toHaveBeenCalled();
      expect(f.integrity.validateWithSettlement).not.toHaveBeenCalled();
      expect((await readdir(f.directory)).filter((name) => name.startsWith('.validation-'))).toEqual([]);
    } finally {
      f.decoderDone.resolve();
      await f.sut.onShutdown();
      vi.restoreAllMocks();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it.each(['mkdir', 'open', 'sync', 'close'] as const)(
    'validation input retains its reservation after owned %s failure',
    async (failure) => {
      const f = await fixture();
      f.admit();
      switch (failure) {
        case 'mkdir': {
          vi.mocked(mkdir).mockRejectedValueOnce(new Error('exclusive directory conflict'));
          break;
        }
        case 'open': {
          vi.mocked(open).mockRejectedValueOnce(new Error('exclusive input conflict'));
          break;
        }
        default: {
          const store = f.repository.storeValidationInput.getMockImplementation()!;
          f.repository.storeValidationInput.mockImplementation(async (...args) => {
            if (args[2].state === 'preparing') {
              const file = (await vi.mocked(open).mock.results.at(-1)!.value) as {
                close: () => Promise<void>;
                sync: () => Promise<void>;
              };
              if (failure === 'sync') vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('sync failure'));
              else {
                const close = file.close.bind(file);
                vi.spyOn(file, 'close').mockImplementationOnce(async () => {
                  await close();
                  throw new Error('close failure');
                });
              }
            }
            return store(...args);
          });
        }
      }
      try {
        await expect(f.sut.validate(f.input)).rejects.toThrow('scheduled_audit_unavailable');
        expect(f.integrity.validateWithSettlement).not.toHaveBeenCalled();
        expect(f.repository.disposeValidationInput).not.toHaveBeenCalled();
        expect(f.repository.finishPrivateWork).toHaveBeenCalledTimes(1);
      } finally {
        f.decoderDone.resolve();
        await f.sut.onShutdown();
        vi.restoreAllMocks();
        await rm(f.directory, { recursive: true, force: true });
      }
    },
  );

  it('validation input disposes before finishing its token on twelve successive passes', async () => {
    const f = await fixture();
    f.admit();
    f.decoderDone.resolve();
    try {
      for (let pass = 0; pass < 12; pass++) {
        const validation = await f.sut.validate(f.input);
        expect((await validation.result).status).toBe('validated');
        await validation.settled;
        expect((await readdir(f.directory)).filter((name) => name.startsWith('.validation-'))).toEqual([]);
        const disposed = f.repository.disposeValidationInput.mock.invocationCallOrder[pass];
        expect(disposed).toBeLessThan(f.repository.finishPrivateWork.mock.invocationCallOrder[pass * 2 + 1]);
        expect(f.repository.disposeValidationInput.mock.calls[pass][1].payload.current.payload.state).toBe('settled');
      }
      expect(f.integrity.validateWithSettlement).toHaveBeenCalledTimes(12);
    } finally {
      await f.sut.onShutdown();
      vi.restoreAllMocks();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});

const ownerId = randomUUID();
const resourceId = randomUUID();
const connectionId = randomUUID();
const auditRequestId = randomUUID();
const operationId = randomUUID();
const seals = new Map<string, { scope: string; payload: string }>();
const seal = (scope: string, payload: unknown) => {
  const token = randomUUID();
  seals.set(token, { scope, payload: canonicalJson(payload) });
  return token;
};
function inputEnvelope(
  state: ValidationInputState,
  overrides: Partial<ValidationInputPayload> = {},
): ValidationInputEnvelope {
  const pathNonce = randomUUID();
  const identity = { dev: 1, ino: 2, uid: 501, size: 10 };
  const stagingDirectory = `/private/staging/${resourceId}`;
  const payload: ValidationInputPayload = {
    version: 1,
    purpose: 'scheduled-weekly-validation-input',
    ownerId,
    resourceId,
    connectionId,
    auditRequestId,
    operationId,
    operationClaimToken: randomUUID(),
    resourceLeaseToken: randomUUID(),
    itemClaimId: randomUUID(),
    sourceAssetId: 'canonical-item',
    sequence: '1',
    pathNonce,
    stage: 'source',
    validationPath: `${stagingDirectory}/complete`,
    sourceIdentity: identity,
    copyGeneration: null,
    stagingDirectory,
    directoryPath: `${stagingDirectory}/.validation-${pathNonce}`,
    inputPath: `${stagingDirectory}/.validation-${pathNonce}/input`,
    directoryIdentity: identity,
    inputIdentity: identity,
    reservedInputBytes: 10,
    state,
    pending: [],
    fresh: {
      payload: {
        version: 1,
        basis: 'audit-fresh-download',
        binding: {
          ownerId,
          resourceId,
          connectionId,
          auditRequestId,
          operationId,
          sourceAssetId: 'canonical-item',
          cohortId: randomUUID(),
          memberOrdinal: '0',
          batchOrdinal: 0,
          grantId: randomUUID(),
          grantGeneration: 1,
          configFingerprint: 'config',
          privacyFingerprint: 'privacy',
          sourceResourceId: randomUUID(),
          identityId: randomUUID(),
          libraryKey: 'library',
          library: { area: 'private', zoneID: { zoneName: 'PrimarySync' } },
          sourceRevision: 'source',
          masterRevision: 'master',
          expectedSha256: 'a'.repeat(64),
          originalAssetId: randomUUID(),
          originalUpdateId: randomUUID(),
          originalPath: '/private/original',
          physicalId: randomUUID(),
          recordId: 'record',
          resourceKey: 'key',
          role: 'original',
          fingerprint: 'fingerprint',
          sizeInBytes: 10,
        },
        path: `${stagingDirectory}/complete`,
        identity: { ...identity, mtimeMs: 1, ctimeMs: 1 },
        sha1: 'b'.repeat(40),
        sha256: 'a'.repeat(64),
        appleFingerprint: 'fingerprint',
      },
      seal: 'fresh-seal',
    },
    ...overrides,
  };
  const envelope = {
    version: 1 as const,
    purpose: 'scheduled-weekly-validation-inputs' as const,
    ownerId,
    resourceId,
    highWater: payload.sequence,
    current: { payload, seal: seal(validationInputScope(payload), payload) },
    previousDisposed: null,
  };
  return { payload: envelope, seal: seal(validationInputsScope(envelope), envelope) };
}

describe('validation input restart discovery', () => {
  it.each(['unproven', 'pending-settlement'] as const)(
    'retains source-only %s work independently of recovery receipts',
    async (reason) => {
      const envelope =
        reason === 'unproven' ? { unknown: true } : inputEnvelope('running', { pending: [randomUUID()] });
      const resource = { id: resourceId, ownerId, verification: { auditValidationInputs: envelope } };
      const repository = {
        retainedValidationInputs: vi.fn().mockResolvedValue([resource]),
        retainValidationInput: vi.fn(),
        deferDisposedValidationInput: vi.fn(),
        retiredPrivateCopies: vi.fn().mockResolvedValue([]),
        disposeValidationInput: vi.fn(),
      };
      const sut = new ICloudScheduledStagingService(
        repository as never,
        {} as never,
        { enabled: () => false } as never,
        {} as never,
      );
      await sut.housekeeping();
      expect(repository.retainValidationInput).toHaveBeenCalledWith(resource, reason);
      expect(repository.disposeValidationInput).not.toHaveBeenCalled();
    },
  );

  it('advances past ten authenticated disposed source-only rows without releasing unknown or source charges', async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      id: randomUUID(),
      ownerId,
      status: 'failed',
      reservedBytes: 10,
      nextAttemptAt: null as Date | null,
      verification: {
        auditValidationInputs: index === 10 ? { unknown: true } : inputEnvelope(index < 10 ? 'disposed' : 'settled'),
      },
    }));
    const repository = {
      retainedValidationInputs: vi.fn(() =>
        Promise.resolve(rows.filter((row) => row.nextAttemptAt === null).slice(0, 10)),
      ),
      validationInputs: vi.fn((input) =>
        Promise.resolve(rows.find((row) => row.id === input.resource.id)!.verification.auditValidationInputs),
      ),
      disposeValidationInput: vi.fn().mockResolvedValue(true),
      deferDisposedValidationInput: vi.fn((input) => {
        rows.find((row) => row.id === input.resource.id)!.nextAttemptAt = new Date(Date.now() + 300_000);
        return Promise.resolve(true);
      }),
      retainValidationInput: vi.fn((resource) => {
        resource.nextAttemptAt = new Date(Date.now() + 300_000);
        return Promise.resolve();
      }),
      retiredPrivateCopies: vi.fn().mockResolvedValue([]),
    };
    const sut = new ICloudScheduledStagingService(
      repository as never,
      {} as never,
      { enabled: () => false } as never,
      {} as never,
    );
    await sut.housekeeping();
    await sut.housekeeping();
    expect(repository.disposeValidationInput).toHaveBeenCalledWith(
      expect.objectContaining({ resource: expect.objectContaining({ id: rows[11].id }) }),
      rows[11].verification.auditValidationInputs,
    );
    expect(repository.retainValidationInput).toHaveBeenCalledWith(rows[10], 'unproven');
    expect(rows.every((row) => row.reservedBytes === 10 && row.status === 'failed')).toBe(true);
  });

  it.each(['match', 'mismatch', 'failed', 'cancelled'])(
    'discovers settled source-only %s input after restart with provider disabled',
    async (result) => {
      const envelope = inputEnvelope('settled');
      const resource = {
        id: resourceId,
        ownerId,
        status: result === 'match' || result === 'mismatch' ? 'committed' : 'failed',
        verification: { auditValidationInputs: envelope },
      };
      const repository = {
        retainedValidationInputs: vi.fn().mockResolvedValue([resource]),
        validationInputs: vi.fn().mockResolvedValue(envelope),
        retainValidationInput: vi.fn(),
        deferDisposedValidationInput: vi.fn(),
        retiredPrivateCopies: vi.fn().mockResolvedValue([]),
        disposeValidationInput: vi.fn().mockResolvedValue(true),
      };
      const sut = new ICloudScheduledStagingService(
        repository as never,
        {} as never,
        { enabled: () => false } as never,
        {} as never,
      );
      await sut.housekeeping();
      expect(repository.disposeValidationInput).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId,
          authority: expect.objectContaining({
            operationClaimToken: envelope.payload.current.payload.operationClaimToken,
          }),
        }),
        envelope,
      );
      expect(repository.retainValidationInput).not.toHaveBeenCalled();
    },
  );
});
