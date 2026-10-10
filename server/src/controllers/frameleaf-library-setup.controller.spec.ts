import { Writable } from 'node:stream';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { FrameleafLibrarySetupController } from 'src/controllers/frameleaf-library-setup.controller.js';
import { SyncEntityType } from 'src/enum.js';

describe(FrameleafLibrarySetupController.name, () => {
  it('never asks the sync service for another account and waits for its final streamed marker', async () => {
    const auth = { user: { id: 'account' }, session: { id: 'phone' } } as AuthDto;
    const setup = {
      status: vi.fn().mockResolvedValue({ phase: 'complete', revision: 'revision' }),
      syncReceipt: vi.fn().mockResolvedValue('receipt'),
    };
    const stream = vi.fn((received: AuthDto, sink: Writable) => {
      expect(received).toBe(auth);
      sink.write(JSON.stringify({ type: 'AssetV2', data: { id: 'own-asset' } }) + '\n');
      sink.end(JSON.stringify({ type: SyncEntityType.SyncCompleteV1 }) + '\n');
      return Promise.resolve();
    });
    const controller = new FrameleafLibrarySetupController(setup as never, { stream } as never);
    let result = '';
    const response = Object.assign(
      new Writable({
        write(chunk, _encoding, done) {
          result += String(chunk);
          done();
        },
      }),
      { setHeader: vi.fn() },
    );
    await controller.warm(auth, {}, response as never);
    expect(result).toContain('own-asset');
    expect(result).toContain('FrameleafSetupRevisionV1');
    expect(setup.syncReceipt).toHaveBeenCalledWith(auth, 'revision');
  });
  it('does not certify a reset or truncated stream', async () => {
    const auth = { user: {}, session: {} } as AuthDto;
    const setup = {
      status: vi.fn().mockResolvedValue({ phase: 'complete', revision: 'revision' }),
      syncReceipt: vi.fn(),
    };
    const stream = vi.fn((_auth: AuthDto, sink: Writable) => {
      sink.end(JSON.stringify({ type: SyncEntityType.SyncResetV1 }) + '\n');
      return Promise.resolve();
    });
    const response = Object.assign(
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      { setHeader: vi.fn() },
    );
    await new FrameleafLibrarySetupController(setup as never, { stream } as never).warm(
      auth,
      { reset: true },
      response as never,
    );
    expect(setup.syncReceipt).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledWith(auth, expect.any(Writable), expect.objectContaining({ reset: true }));
  });
  it('enforces the independent Manager machine credential before any state access', async () => {
    const setup = {
      authorizeManager: vi.fn().mockRejectedValue(new Error('Forbidden')),
      status: vi.fn(),
      begin: vi.fn(),
    };
    const controller = new FrameleafLibrarySetupController(setup as never, {} as never);
    await expect(controller.managerStatus()).rejects.toThrow('Forbidden');
    await expect(controller.managerBegin('invalid')).rejects.toThrow('Forbidden');
    expect(setup.status).not.toHaveBeenCalled();
    expect(setup.begin).not.toHaveBeenCalled();
  });
});
