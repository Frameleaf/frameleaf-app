import type { NextFunction, Request, Response } from 'express';
import { DatabaseLock, ExitCode } from 'src/enum.js';
import { FirstLaunchBackup, FirstLaunchBackupError, FirstLaunchOutcome } from 'src/maintenance/first-launch-backup.js';
import { FirstLaunchWorkerService } from 'src/maintenance/first-launch-worker.service.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { FIRST_LAUNCH_PAGE, FIRST_LAUNCH_STATUS_PATH } from 'src/utils/first-launch.js';
import { AutoMocked, ServiceMocks, automock, getMocks } from 'test/utils.js';

const backup = { filename: 'immich-db-backup-20261001T101500-pre-upgrade-v3.2.0-pg14.19.sql.gz', takenAt: 'x' };

const request = (url: string, method = 'GET') =>
  ({ url, originalUrl: url, path: url.split('?', 1)[0], method }) as unknown as Request;

const response = () => {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    redirectedTo: undefined as string | undefined,
    contentType: undefined as string | undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    header(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    type(value: string) {
      res.contentType = value;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
    redirect(target: string) {
      res.statusCode = 302;
      res.redirectedTo = target;
      return res;
    },
  };
  return res;
};

describe(FirstLaunchWorkerService.name, () => {
  let sut: FirstLaunchWorkerService;
  let mocks: ServiceMocks;
  let backups: AutoMocked<DatabaseBackupService>;
  let run: ReturnType<typeof vi.fn<FirstLaunchBackup['run']>>;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks = getMocks();
    backups = automock(DatabaseBackupService, {
      args: [mocks.logger, mocks.storage, mocks.config, mocks.systemMetadata, mocks.process, mocks.database],
      strict: false,
    });
    sut = new FirstLaunchWorkerService(
      mocks.logger as never,
      mocks.app,
      mocks.config,
      mocks.database as never,
      mocks.storage as never,
      backups,
    );
    run = vi.fn<FirstLaunchBackup['run']>();
    vi.spyOn(sut as unknown as { firstLaunchBackup: () => unknown }, 'firstLaunchBackup').mockReturnValue({ run });
    mocks.config.getEnv.mockReturnValue({
      ...mocks.config.getEnv(),
      resourcePaths: {
        ...mocks.config.getEnv().resourcePaths,
        web: { ...mocks.config.getEnv().resourcePaths.web, indexHtml: '/nonexistent/index.html' },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('prepare', () => {
    it('takes the copy under the boot migration lock', async () => {
      run.mockResolvedValue({ kind: 'created', backup });

      await sut.prepare();

      expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.Migrations, expect.any(Function));
      expect(run).toHaveBeenCalledOnce();
    });

    it('reports checking, then backing up, then done with the copy, then hands over to normal startup', async () => {
      const seen: string[] = [];
      run.mockImplementation(({ onProgress } = {}) => {
        seen.push(sut.getStatus().state);
        onProgress?.('checking');
        seen.push(sut.getStatus().state);
        onProgress?.('backing-up');
        seen.push(sut.getStatus().state);
        return Promise.resolve({ kind: 'created', backup } satisfies FirstLaunchOutcome);
      });

      await sut.prepare();

      expect(seen).toEqual(['checking', 'checking', 'backing-up']);
      expect(sut.getStatus()).toEqual({ state: 'done', copy: 'taken', backup });
      expect(mocks.app.stop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2000);
      expect(sut.getStatus()).toEqual({ state: 'ready', copy: 'taken', backup });
      expect(mocks.app.stop).toHaveBeenCalledWith(ExitCode.FirstLaunchReady, expect.any(Object));
    });

    it('shows which recent backup made the copy unnecessary for a few seconds before handing over', async () => {
      run.mockResolvedValue({ kind: 'skipped', backup });

      await sut.prepare();

      expect(sut.getStatus()).toEqual({ state: 'skipped', copy: 'skipped', backup });
      await vi.advanceTimersByTimeAsync(4000);
      expect(mocks.app.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.app.stop).toHaveBeenCalledWith(ExitCode.FirstLaunchReady, expect.any(Object));
    });

    it('hands over at once when another server already upgraded the library', async () => {
      run.mockResolvedValue({ kind: 'not-needed' });

      await sut.prepare();

      expect(sut.getStatus().state).toBe('ready');
      expect(mocks.app.stop).toHaveBeenCalledWith(ExitCode.FirstLaunchReady, expect.any(Object));
    });

    it('stays on the error screen when there is not enough space, and never hands over', async () => {
      run.mockRejectedValue(
        new FirstLaunchBackupError('disk-space', 'not enough space in /data/backups', {
          requiredBytes: 10,
          availableBytes: 5,
          folder: '/data/backups',
        }),
      );

      await sut.prepare();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(sut.getStatus()).toEqual({
        state: 'failed',
        error: { reason: 'disk-space', requiredBytes: 10, availableBytes: 5 },
      });
      expect(mocks.app.stop).not.toHaveBeenCalled();
      expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('not enough space in /data/backups'));
    });

    it('reports any other failure without its details on the public screen', async () => {
      run.mockRejectedValue(new Error('connection refused at 10.0.0.2:5432 password=secret'));

      await sut.prepare();

      expect(sut.getStatus()).toEqual({ state: 'failed', error: { reason: 'backup-failed' } });
      expect(JSON.stringify(sut.getStatus())).not.toContain('secret');
      expect(mocks.app.stop).not.toHaveBeenCalled();
    });
  });

  describe('ssr', () => {
    const handle = (url: string, method = 'GET') => {
      const res = response();
      const next = vi.fn() as NextFunction;
      sut.ssr(['/.well-known/immich', '/custom.css', '/favicon.ico'])(
        request(url, method),
        res as unknown as Response,
        next,
      );
      return { res, next };
    };

    it('answers the status for the page', () => {
      const { res } = handle(FIRST_LAUNCH_STATUS_PATH);

      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ state: 'checking' });
    });

    it.each([
      ['/api/server/ping', 'GET'],
      ['/api/server/config', 'GET'],
      ['/api/users/me', 'GET'],
      ['/api/assets', 'POST'],
      ['/api/auth/login', 'POST'],
      ['/api/socket.io/?EIO=4&transport=polling', 'GET'],
      ['/.well-known/immich', 'GET'],
      ['/custom.css', 'GET'],
      ['/photos', 'POST'],
    ])('refuses %s %s with 503 and Retry-After', (url, method) => {
      const { res, next } = handle(url, method);

      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toMatchObject({ statusCode: 503 });
      expect(next).not.toHaveBeenCalled();
    });

    it('serves the page itself', () => {
      const { res } = handle(`${FIRST_LAUNCH_PAGE}?continue=%2Fphotos`);

      expect(res.statusCode).toBe(200);
      expect(res.contentType).toBe('text/html');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it.each(['/', '/photos', '/auth/login', '/admin/users?x=1'])('sends %s to the page and back afterwards', (url) => {
      const { res } = handle(url);

      expect(res.statusCode).toBe(302);
      expect(res.redirectedTo).toBe(`${FIRST_LAUNCH_PAGE}?${new URLSearchParams({ continue: url })}`);
    });

    it('keeps only the path of an auth callback, never its one-time code', () => {
      const { res } = handle('/auth/login?code=abc&state=def');

      expect(res.redirectedTo).toBe(`${FIRST_LAUNCH_PAGE}?${new URLSearchParams({ continue: '/auth/login' })}`);
    });

    it('lets the favicon through to the static files', () => {
      const { next } = handle('/favicon.ico');

      expect(next).toHaveBeenCalled();
    });
  });
});
