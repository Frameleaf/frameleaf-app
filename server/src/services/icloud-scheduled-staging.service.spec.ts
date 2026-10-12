import { createHash } from 'node:crypto';
import { mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetType } from 'src/enum.js';
import { ICloudScheduledStagingService } from 'src/services/icloud-scheduled-staging.service.js';

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
      beginPrivateWork: vi.fn().mockResolvedValue('owned-work'),
      planValidationInput: vi.fn().mockResolvedValue(undefined),
      finishPrivateWork: vi.fn(),
      disposeValidationInput: vi.fn().mockResolvedValue(true),
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
    return { directory, destination, input, repository, integrity, decoderDone, sut, cached, receipt };
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

  it('validation input remains present while final readonly work is unsettled', async () => {
    const f = await fixture();
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
      expect(f.repository.finishPrivateWork).not.toHaveBeenCalled();
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
});
