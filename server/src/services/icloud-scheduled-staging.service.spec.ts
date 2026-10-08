import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
