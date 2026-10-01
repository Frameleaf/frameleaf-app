import { describe, expect, it, vi } from 'vitest';
import {
  GETTING_READY_POLL_MS,
  GETTING_READY_STATUS_URL,
  advanceGettingReady,
  gettingReadyView,
  isPreUpgradeBackup,
  pollGettingReady,
  type GettingReadyStatus,
} from './getting-ready';

const backup = { filename: 'immich-db-backup-20261001T101500-pre-upgrade-v3.2.0-pg14.19.sql.gz', takenAt: 'x' };

const respond = (status: number, body?: unknown) =>
  vi.fn().mockResolvedValue(new Response(body === undefined ? null : JSON.stringify(body), { status }));

describe('getting-ready (FL-295)', () => {
  describe('pollGettingReady', () => {
    it('reads the status the "Getting Ready…" worker serves', async () => {
      const fetchFn = respond(200, { state: 'backing-up' });

      await expect(pollGettingReady(fetchFn)).resolves.toEqual({ kind: 'status', status: { state: 'backing-up' } });
      expect(fetchFn).toHaveBeenCalledWith(GETTING_READY_STATUS_URL, expect.objectContaining({ cache: 'no-store' }));
    });

    it('is finished once the normal server answers (it has no such route)', async () => {
      await expect(pollGettingReady(respond(404, { message: 'Cannot GET' }))).resolves.toEqual({ kind: 'finished' });
    });

    it.each([
      ['the server restarting (no answer)', vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))],
      ['a proxy with no server behind it', respond(502)],
      ['a refused request', respond(503, { statusCode: 503 })],
    ])('is starting during %s', async (_, fetchFn) => {
      await expect(pollGettingReady(fetchFn)).resolves.toEqual({ kind: 'starting' });
    });

    it('polls every second', () => {
      expect(GETTING_READY_POLL_MS).toBe(1000);
    });
  });

  describe('advanceGettingReady', () => {
    it('takes the new status', () => {
      expect(advanceGettingReady({ state: 'checking' }, { kind: 'status', status: { state: 'backing-up' } })).toEqual({
        state: 'backing-up',
      });
    });

    it('treats a server that stopped answering after the copy as handing over', () => {
      const done: GettingReadyStatus = { state: 'done', copy: 'taken', backup };
      expect(advanceGettingReady(done, { kind: 'starting' })).toEqual({ state: 'ready', copy: 'taken', backup });
    });

    it('keeps the current status while the worker is not answering yet', () => {
      expect(advanceGettingReady(undefined, { kind: 'starting' })).toBeUndefined();
      expect(advanceGettingReady({ state: 'backing-up' }, { kind: 'starting' })).toEqual({ state: 'backing-up' });
    });

    it('keeps an error on screen even if the server is restarted', () => {
      const failed: GettingReadyStatus = { state: 'failed', error: { reason: 'backup-failed' } };
      expect(advanceGettingReady(failed, { kind: 'starting' })).toEqual(failed);
    });

    it('says finished when the normal server is up', () => {
      expect(advanceGettingReady({ state: 'ready' }, { kind: 'finished' })).toBe('finished');
    });
  });

  describe('gettingReadyView', () => {
    it('shows the copy running and the upgrade waiting while it checks or copies', () => {
      for (const state of ['checking', 'backing-up'] as const) {
        expect(gettingReadyView({ state })).toEqual({
          kind: 'working',
          state,
          tasks: [
            { id: 'copy', status: 'running' },
            { id: 'upgrade', status: 'queued' },
          ],
        });
      }
      expect(gettingReadyView(undefined)).toMatchObject({ kind: 'working', state: 'checking' });
    });

    it('names the recent backup that made the copy unnecessary', () => {
      expect(gettingReadyView({ state: 'skipped', copy: 'skipped', backup })).toEqual({
        kind: 'skipped',
        backup,
        tasks: [
          { id: 'copy', status: 'skipped' },
          { id: 'upgrade', status: 'queued' },
        ],
      });
    });

    it('names the copy once saved', () => {
      expect(gettingReadyView({ state: 'done', copy: 'taken', backup })).toEqual({
        kind: 'saved',
        backup,
        tasks: [
          { id: 'copy', status: 'done' },
          { id: 'upgrade', status: 'queued' },
        ],
      });
    });

    it('shows the upgrade running once it hands over', () => {
      expect(gettingReadyView({ state: 'ready', copy: 'taken', backup })).toEqual({
        kind: 'finishing',
        tasks: [
          { id: 'copy', status: 'done' },
          { id: 'upgrade', status: 'running' },
        ],
      });
      expect(gettingReadyView({ state: 'ready', copy: 'skipped', backup }).tasks[0]).toEqual({
        id: 'copy',
        status: 'skipped',
      });
    });

    it('explains a space problem with its figures, and any other failure plainly', () => {
      expect(
        gettingReadyView({ state: 'failed', error: { reason: 'disk-space', requiredBytes: 10, availableBytes: 5 } }),
      ).toEqual({
        kind: 'failed',
        reason: 'disk-space',
        requiredBytes: 10,
        availableBytes: 5,
        tasks: [
          { id: 'copy', status: 'failed' },
          { id: 'upgrade', status: 'queued' },
        ],
      });
      expect(gettingReadyView({ state: 'failed', error: { reason: 'backup-failed' } })).toMatchObject({
        kind: 'failed',
        reason: 'backup-failed',
      });
    });
  });

  describe('isPreUpgradeBackup', () => {
    it('recognises the pre-upgrade copy among the backups', () => {
      expect(isPreUpgradeBackup(backup.filename)).toBe(true);
      expect(isPreUpgradeBackup('immich-db-backup-20261001T101500-v3.1.0-pg14.19.sql.gz')).toBe(false);
      expect(isPreUpgradeBackup(`restore-point-${backup.filename}`)).toBe(false);
    });
  });
});
