import type { AdminConfigDto, AdminConfigRevisionResponseDto, AdminConfigRevisionUpdateDto } from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneConfig } from '$lib/frameleaf/system-config-draft';
import { SystemConfigDraftStore, type SystemConfigDraftStorage } from '$lib/frameleaf/system-config-draft.svelte';
import { adminConfigFixture, adminConfigWith } from '@test-data/factories/admin-config-factory';

vi.mock('@immich/sdk', async (originalImport) => ({
  ...(await originalImport<typeof import('@immich/sdk')>()),
  isHttpError: (error: unknown) => typeof error === 'object' && error !== null && 'status' in error,
}));

vi.mock('$lib/utils/handle-error', () => ({
  getServerErrorMessage: (error: { data?: { message?: string } }) => error?.data?.message,
}));

const httpError = (status: number, message: string) => ({ status, data: { message } });

const current = (config: AdminConfigDto, revision: string): AdminConfigRevisionResponseDto => ({ config, revision });

/** Session storage for one tab, shared by the stores a reload creates. */
const memoryStorage = () => {
  let value: string | null = null;
  const storage: SystemConfigDraftStorage & { value: () => string | null } = {
    read: () => value,
    write: (next) => {
      value = next;
    },
    remove: () => {
      value = null;
    },
    value: () => value,
  };
  return storage;
};

describe('SystemConfigDraftStore (FL-66)', () => {
  let save: ReturnType<typeof vi.fn<(update: AdminConfigRevisionUpdateDto) => Promise<AdminConfigRevisionResponseDto>>>;
  let load: ReturnType<typeof vi.fn<() => Promise<AdminConfigRevisionResponseDto>>>;
  let onUpdated: ReturnType<typeof vi.fn<(config: AdminConfigDto) => void>>;
  let storage: ReturnType<typeof memoryStorage>;

  const defaults = adminConfigWith((config) => {
    config.trash.days = 30;
    config.ffmpeg.crf = 23;
  });

  const createStore = (loaded = current(adminConfigFixture(), 'r1')) =>
    new SystemConfigDraftStore(loaded, { defaults, save, load, onUpdated, storage });

  beforeEach(() => {
    save = vi.fn();
    load = vi.fn();
    onUpdated = vi.fn();
    storage = memoryStorage();
  });

  it('keeps one draft across pages and saves it once against the loaded revision', async () => {
    const store = createStore();
    store.draft.trash.days = 10;
    store.draft.ffmpeg.crf = 28;
    expect(store.changes.map(({ path }) => path)).toEqual(['trash.days', 'ffmpeg.crf']);

    const saved = adminConfigWith((config) => {
      config.trash.days = 10;
      config.ffmpeg.crf = 28;
    });
    save.mockResolvedValue(current(saved, 'r2'));

    await expect(store.save()).resolves.toBe(true);

    expect(save).toHaveBeenCalledTimes(1);
    const [{ config, expectedRevision }] = save.mock.calls[0];
    expect(expectedRevision).toBe('r1');
    expect(config.trash.days).toBe(10);
    expect(config.ffmpeg.crf).toBe(28);
    expect(store.revision).toBe('r2');
    expect(store.dirty).toBe(false);
    expect(store.notice).toEqual({ code: 'saved' });
    expect(onUpdated).toHaveBeenCalledWith(saved);
  });

  it('keeps edits made while a save is on its way', async () => {
    const store = createStore();
    store.draft.trash.days = 10;
    let answer: (value: AdminConfigRevisionResponseDto) => void = () => {};
    save.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    const saving = store.save();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    store.draft.ffmpeg.crf = 28;
    answer(
      current(
        adminConfigWith((config) => (config.trash.days = 10)),
        'r2',
      ),
    );
    await saving;

    expect(store.revision).toBe('r2');
    expect(store.changes).toEqual([{ path: 'ffmpeg.crf', before: 23, after: 28 }]);
  });

  it('never follows a load that a save overtook', async () => {
    const store = createStore();
    let answerLoad: (value: AdminConfigRevisionResponseDto) => void = () => {};
    load.mockReturnValue(new Promise((resolve) => (answerLoad = resolve)));
    const refreshing = store.refresh();

    store.draft.trash.days = 10;
    save.mockResolvedValue(
      current(
        adminConfigWith((config) => (config.trash.days = 10)),
        'r2',
      ),
    );
    await store.save();

    // The load read the settings before the save; its answer is older than what the draft has.
    answerLoad(current(adminConfigFixture(), 'r1'));
    await refreshing;

    expect(store.revision).toBe('r2');
    expect(store.baseline.trash.days).toBe(10);
  });

  it('keeps the draft when a save fails for another reason', async () => {
    const store = createStore();
    store.draft.trash.days = 10;
    save.mockRejectedValue(httpError(400, 'Trash days must be positive'));

    await expect(store.save()).resolves.toBe(false);

    expect(store.error).toEqual({ code: 'save_failed', detail: 'Trash days must be positive' });
    expect(store.draft.trash.days).toBe(10);
    expect(store.dirty).toBe(true);
    expect(store.revision).toBe('r1');
  });

  describe('concurrent administrators', () => {
    it('carries a draft onto settings another administrator saved when they do not overlap', async () => {
      const store = createStore();
      store.draft.trash.days = 10;
      save.mockRejectedValueOnce(httpError(409, 'The system settings changed after they were loaded.'));
      load.mockResolvedValue(
        current(
          adminConfigWith((config) => (config.ffmpeg.crf = 30)),
          'r2',
        ),
      );

      await expect(store.save()).resolves.toBe(false);

      expect(store.stale).toBe(false);
      expect(store.revision).toBe('r2');
      expect(store.baseline.ffmpeg.crf).toBe(30);
      expect(store.draft.trash.days).toBe(10);
      expect(store.notice).toEqual({ code: 'rebased' });
      expect(store.error).toBeNull();

      save.mockResolvedValue(
        current(
          adminConfigWith((config) => (config.trash.days = 10)),
          'r3',
        ),
      );
      await expect(store.save()).resolves.toBe(true);
      expect(save.mock.calls[1][0].expectedRevision).toBe('r2');
    });

    it('marks the draft stale and names the conflicts when both changed the same setting', async () => {
      const store = createStore();
      store.draft.trash.days = 10;
      save.mockRejectedValueOnce(httpError(409, 'changed'));
      load.mockResolvedValue(
        current(
          adminConfigWith((config) => (config.trash.days = 60)),
          'r2',
        ),
      );

      await store.save();

      expect(store.stale).toBe(true);
      expect(store.conflicts).toEqual([{ path: 'trash.days', before: 30, mine: 10, theirs: 60 }]);
      expect(store.draft.trash.days).toBe(10);

      // A stale draft is never sent.
      await expect(store.save()).resolves.toBe(false);
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('lets the administrator keep their values on the latest settings after reviewing', async () => {
      const store = createStore();
      store.draft.trash.days = 10;
      store.follow(
        current(
          adminConfigWith((config) => (config.trash.days = 60)),
          'r2',
        ),
      );
      expect(store.stale).toBe(true);

      store.keepMine();

      expect(store.stale).toBe(false);
      expect(store.revision).toBe('r2');
      expect(store.baseline.trash.days).toBe(60);
      expect(store.draft.trash.days).toBe(10);
      expect(store.changes).toEqual([{ path: 'trash.days', before: 60, after: 10 }]);
    });

    it('discards the draft and loads the latest settings on request', async () => {
      const store = createStore();
      store.draft.trash.days = 10;
      store.follow(
        current(
          adminConfigWith((config) => (config.trash.days = 60)),
          'r2',
        ),
      );
      load.mockResolvedValue(
        current(
          adminConfigWith((config) => (config.trash.days = 60)),
          'r2',
        ),
      );

      await expect(store.loadLatest()).resolves.toBe(true);

      expect(store.stale).toBe(false);
      expect(store.dirty).toBe(false);
      expect(store.draft.trash.days).toBe(60);
      expect(store.notice).toEqual({ code: 'latest_loaded' });
    });

    it('takes newer settings silently while nothing is pending', () => {
      const store = createStore();
      const latest = adminConfigWith((config) => (config.map.enabled = false));

      store.follow(current(latest, 'r2'));

      expect(store.revision).toBe('r2');
      expect(store.draft.map.enabled).toBe(false);
      expect(store.notice).toBeNull();
      expect(onUpdated).toHaveBeenCalledWith(latest);
    });

    it('picks up the re-queue reminder without treating it as a change', () => {
      const store = createStore();
      store.draft.trash.days = 10;
      const latest = adminConfigWith(
        (config) => (config.machineLearning.imageDescription!.pendingRequeueAt = '2026-09-23T10:00:00.000Z'),
      );

      // Server-kept values do not change the revision.
      store.follow(current(latest, 'r1'));

      expect(store.baseline.machineLearning.imageDescription!.pendingRequeueAt).toBe('2026-09-23T10:00:00.000Z');
      expect(store.changes.map(({ path }) => path)).toEqual(['trash.days']);
      expect(store.stale).toBe(false);
    });
  });

  it('runs a page guard only when its settings changed, and stops the save when it declines', async () => {
    const store = createStore();
    const confirm = vi.fn(() => Promise.resolve(false));
    store.registerGuard({ keys: ['passwordLogin', 'oauth'], beforeSave: confirm });

    store.draft.trash.days = 10;
    save.mockResolvedValue(
      current(
        adminConfigWith((config) => (config.trash.days = 10)),
        'r2',
      ),
    );
    await expect(store.save()).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();

    store.draft.passwordLogin.enabled = false;
    await expect(store.save()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.draft.passwordLogin.enabled).toBe(false);
  });

  it('saves only the email settings for a delivery test and keeps every other change pending', async () => {
    const store = createStore();
    store.draft.trash.days = 10;
    store.draft.notifications.smtp.enabled = true;
    save.mockImplementation(({ config }) => Promise.resolve(current(cloneConfig(config), 'r2')));

    await expect(store.saveKeys(['notifications'])).resolves.toBe(true);

    const [{ config, expectedRevision }] = save.mock.calls[0];
    expect(expectedRevision).toBe('r1');
    expect(config.notifications.smtp.enabled).toBe(true);
    expect(config.trash.days).toBe(30);
    expect(store.revision).toBe('r2');
    expect(store.baseline.notifications.smtp.enabled).toBe(true);
    expect(store.changes).toEqual([{ path: 'trash.days', before: 30, after: 10 }]);
    expect(store.notice).toEqual({ code: 'partial_saved' });
  });

  it('keeps the draft when the email settings save fails', async () => {
    const store = createStore();
    store.draft.notifications.smtp.enabled = true;
    save.mockRejectedValue(httpError(500, 'boom'));

    await expect(store.saveKeys(['notifications'])).resolves.toBe(false);

    expect(store.error).toEqual({ code: 'partial_save_failed', detail: 'boom' });
    expect(store.draft.notifications.smtp.enabled).toBe(true);
  });

  it('"Reset this page" puts the defaults into the draft and Discard returns to the saved settings', () => {
    const store = createStore(
      current(
        adminConfigWith((config) => (config.trash.days = 5)),
        'r1',
      ),
    );

    store.resetSection(['trash']);
    expect(store.draft.trash.days).toBe(30);
    expect(store.notice).toEqual({ code: 'defaults_restored' });

    store.discard();
    expect(store.draft.trash.days).toBe(5);
    expect(store.dirty).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('imports a settings file into the draft for review and reports what it ignored', () => {
    const store = createStore();

    const imported = store.importFile(
      JSON.stringify({ trash: { days: 12 }, oauth: { clientSecret: '' }, retired: { setting: true } }),
    );

    expect(imported).toBe(true);
    expect(store.draft.trash.days).toBe(12);
    expect(store.draft.oauth.clientSecret).toBe('oauth-secret');
    expect(store.notice).toEqual({
      code: 'imported',
      applied: 1,
      unsupported: ['retired.setting'],
      keptSecrets: 1,
      skippedSecrets: 0,
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a file that is not JSON without touching the draft', () => {
    const store = createStore();
    store.draft.trash.days = 10;

    expect(store.importFile('not json')).toBe(false);

    expect(store.error?.code).toBe('invalid_file');
    expect(store.draft.trash.days).toBe(10);
  });

  describe('reload recovery', () => {
    it('recovers the draft after a reload, without the secrets it never kept', () => {
      const before = createStore();
      before.draft.trash.days = 10;
      before.draft.notifications.smtp.transport.password = 'typed-secret';
      before.persistJournal();

      expect(before.unjournaled).toBe(1);
      expect(storage.value()).not.toContain('typed-secret');

      const after = createStore();
      expect(after.recover()).toBe(true);
      expect(after.draft.trash.days).toBe(10);
      expect(after.draft.notifications.smtp.transport.password).toBe('smtp-secret');
      expect(after.notice).toEqual({ code: 'recovered', count: 1, dropped: 0 });
    });

    it('marks recovered changes stale when the setting was saved differently in between', () => {
      const before = createStore();
      before.draft.trash.days = 10;
      before.persistJournal();

      const after = createStore(
        current(
          adminConfigWith((config) => (config.trash.days = 60)),
          'r2',
        ),
      );
      after.recover();

      expect(after.stale).toBe(true);
      expect(after.conflicts).toEqual([{ path: 'trash.days', before: 30, mine: 10, theirs: 60 }]);
      expect(after.draft.trash.days).toBe(10);
    });

    it('still finds a recovered conflict after another reload or an unrelated save elsewhere', () => {
      const first = createStore();
      first.draft.trash.days = 10;
      first.persistJournal();

      const changedElsewhere = adminConfigWith((config) => (config.trash.days = 60));
      const second = createStore(current(changedElsewhere, 'r2'));
      second.recover();
      second.persistJournal();

      const third = createStore(current(changedElsewhere, 'r2'));
      third.recover();
      expect(third.stale).toBe(true);
      expect(third.conflicts.map(({ path }) => path)).toEqual(['trash.days']);

      // Another administrator saves something unrelated: the conflict is still there.
      third.follow(
        current(
          adminConfigWith((config) => {
            config.trash.days = 60;
            config.ffmpeg.crf = 30;
          }),
          'r3',
        ),
      );
      expect(third.stale).toBe(true);
      expect(third.conflicts).toEqual([{ path: 'trash.days', before: 30, mine: 10, theirs: 60 }]);
    });

    it('clears the journal once the draft is saved or discarded', async () => {
      const store = createStore();
      store.draft.trash.days = 10;
      store.persistJournal();
      expect(storage.value()).not.toBeNull();

      save.mockResolvedValue(
        current(
          adminConfigWith((config) => (config.trash.days = 10)),
          'r2',
        ),
      );
      await store.save();
      expect(storage.value()).toBeNull();
    });

    it('keeps working when this browser refuses session storage', () => {
      const store = new SystemConfigDraftStore(current(adminConfigFixture(), 'r1'), {
        defaults,
        save,
        load,
        storage: {
          read: () => {
            throw new Error('SecurityError');
          },
          write: () => {
            throw new Error('QuotaExceededError');
          },
          remove: () => {
            throw new Error('SecurityError');
          },
        },
      });

      expect(store.recover()).toBe(false);
      store.draft.trash.days = 10;
      store.persistJournal();

      expect(store.journalAvailable).toBe(false);
      expect(store.dirty).toBe(true);
    });
  });
});
