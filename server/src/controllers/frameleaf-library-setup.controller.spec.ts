import { Writable } from 'node:stream';
import request from 'supertest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { FrameleafLibrarySetupController } from 'src/controllers/frameleaf-library-setup.controller.js';
import { SyncEntityType } from 'src/enum.js';
import { frameleafViaMiddleware } from 'src/middleware/frameleaf-via.middleware.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { SyncService } from 'src/services/sync.service.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

const MANAGER_TOKEN = 'a'.repeat(64);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = (path: unknown, ...rest: unknown[]) =>
    path === '/run/frameleaf/manager-token'
      ? Promise.resolve(`${MANAGER_TOKEN}\n`)
      : (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  return { ...actual, default: { ...actual, readFile }, readFile };
});

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

describe(`${FrameleafLibrarySetupController.name} Manager endpoints through the request pipeline`, () => {
  const edgeSecret = 'edge-secret-0123456789abcdef';
  // The real token check, so the header has to survive every middleware the server installs first.
  const setup = Object.assign(Object.create(FrameleafLibrarySetupService.prototype), {
    status: vi.fn().mockResolvedValue({ phase: 'preparing' }),
    begin: vi.fn().mockResolvedValue(undefined),
  });
  let ctx: ControllerContext;

  beforeAll(async () => {
    vi.stubEnv('FRAMELEAF_MANAGER_TOKEN_FILE', '/run/frameleaf/manager-token');
    vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', 'b'.repeat(12));
    vi.stubEnv('FRAMELEAF_MANAGER_ORIGIN', 'new_library');
    ctx = await controllerSetup(
      FrameleafLibrarySetupController,
      [
        { provide: FrameleafLibrarySetupService, useValue: setup },
        { provide: SyncService, useValue: {} },
      ],
      [frameleafViaMiddleware(edgeSecret)],
    );
    return async () => {
      await ctx.close();
      vi.unstubAllEnvs();
    };
  });

  beforeEach(() => {
    setup.begin.mockClear();
  });

  it('accepts the Manager token Manager sends from inside the container', async () => {
    const status = await request(ctx.getHttpServer())
      .get('/server/library-setup/manager')
      .set('x-frameleaf-manager', MANAGER_TOKEN);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ phase: 'preparing' });

    const begin = await request(ctx.getHttpServer())
      .post('/server/library-setup/manager')
      .set('x-frameleaf-manager', MANAGER_TOKEN);
    expect(begin.status).toBe(201);
    expect(setup.begin).toHaveBeenCalledWith(true);
  });

  it('refuses a wrong token and a token that arrived through remote access', async () => {
    const wrong = await request(ctx.getHttpServer())
      .post('/server/library-setup/manager')
      .set('x-frameleaf-manager', 'c'.repeat(64));
    expect(wrong.status).toBe(403);

    const remote = await request(ctx.getHttpServer())
      .post('/server/library-setup/manager')
      .set('x-frameleaf-via', 'wan')
      .set('x-frameleaf-via-auth', edgeSecret)
      .set('x-frameleaf-manager', MANAGER_TOKEN);
    expect(remote.status).toBe(403);
    expect(setup.begin).not.toHaveBeenCalled();
  });
});
