/**
 * The system settings draft of the Frameleaf settings host (FL-66): one draft across every
 * settings area, the revision it was loaded at, and the save, discard, reset, conflict and
 * recovery actions of the design template's `CommandCenter.jsx`. It follows the account
 * preferences draft (FL-77, `account-preferences-draft.svelte.ts`) with the same revision
 * contract: every save sends `expectedRevision` and the server refuses (409) a save made against
 * settings that changed since, so nothing is overwritten and the draft is kept.
 *
 * Transaction boundaries. The draft only ever commits the system configuration, as one request.
 * Resource actions on the settings pages (unlinking OAuth accounts, adding Frameleaf Cloud,
 * re-queueing descriptions, machine learning destinations) go through their own endpoints and
 * permissions and never ride along with a settings save; the pages call `refresh()` after one so
 * a value a resource action wrote on the server becomes the new baseline instead of a conflict.
 * The one combined action is the email delivery test, which saves the email settings only
 * (`saveKeys`) and leaves every other pending change in the draft.
 *
 * The draft is journaled to this tab's session storage so a reload recovers it; secrets and
 * credentials are never written there (see `createJournal`).
 */
import {
  isHttpError,
  type AdminConfigDto,
  type AdminConfigRevisionResponseDto,
  type AdminConfigRevisionUpdateDto,
} from '@immich/sdk';
import { get, isEqual, set } from 'lodash-es';
import { getContext, setContext } from 'svelte';
import {
  changedConfigKeys,
  cloneConfig,
  configKeysDiffer,
  createJournal,
  diffConfig,
  importConfig,
  parseJournal,
  pickConfigKeys,
  rebaseDraft,
  recoverJournal,
  resetConfigKeys,
  SERVER_MANAGED_CONFIG_PATHS,
  type ConfigConflict,
} from '$lib/frameleaf/system-config-draft';
import { getServerErrorMessage } from '$lib/utils/handle-error';

export type SystemConfigDraftError = {
  code: 'save_failed' | 'partial_save_failed' | 'load_failed' | 'invalid_file';
  detail?: string;
};

type SystemConfigDraftMessage =
  'saved' | 'partial_saved' | 'discarded' | 'defaults_restored' | 'latest_loaded' | 'rebased' | 'kept_mine';

export type SystemConfigDraftNotice =
  | { code: SystemConfigDraftMessage }
  | { code: 'recovered'; count: number; dropped: number }
  | { code: 'imported'; applied: number; unsupported: string[]; keptSecrets: number; skippedSecrets: number };

/** Where the reload journal lives. Every call may throw (storage disabled or full). */
export type SystemConfigDraftStorage = {
  read: () => string | null;
  write: (value: string) => void;
  remove: () => void;
};

export type SystemConfigDraftOptions = {
  defaults: AdminConfigDto;
  load: () => Promise<AdminConfigRevisionResponseDto>;
  save: (update: AdminConfigRevisionUpdateDto) => Promise<AdminConfigRevisionResponseDto>;
  /** Called with the saved settings whenever the baseline changes (save, load, follow). */
  onUpdated?: (config: AdminConfigDto) => void;
  storage?: SystemConfigDraftStorage;
};

export type SystemConfigSaveGuard = {
  /** The configuration groups the guard is about; it only runs when one of them changed. */
  keys: readonly string[];
  /** Resolve false to stop the save (for example when a confirmation is declined). */
  beforeSave: () => boolean | Promise<boolean>;
};

export const isSystemConfigConflict = (error: unknown) => isHttpError(error) && error.status === 409;

export class SystemConfigDraftStore {
  /** The saved settings the draft was made against. Replaced, never edited in place. */
  baseline: AdminConfigDto = $state.raw({} as AdminConfigDto);
  /** The draft every settings page edits in place. */
  draft: AdminConfigDto = $state({} as AdminConfigDto);
  revision = $state('');
  /** Newer saved settings that conflict with the draft; set while the draft is stale. */
  latest: AdminConfigRevisionResponseDto | null = $state.raw(null);
  conflicts: ConfigConflict[] = $state.raw([]);
  saving = $state(false);
  loading = $state(false);
  error: SystemConfigDraftError | null = $state.raw(null);
  notice: SystemConfigDraftNotice | null = $state.raw(null);
  /** Pending changes that cannot be kept across a reload (secrets and credentials). */
  unjournaled = $state(0);
  /** False once session storage refused the journal. */
  journalAvailable = $state(true);

  changes = $derived(diffConfig(this.baseline, this.draft));
  /** Bumped when a page asks the settings bar to open its change review (the Job manager's concurrency). */
  reviewRequests = $state(0);

  readonly defaults: AdminConfigDto;
  #options: SystemConfigDraftOptions;
  #guards = new Set<SystemConfigSaveGuard>();
  /** Bumped by every save and load, so an answer overtaken by a newer one is never followed. */
  #generation = 0;
  #refreshAgain = false;

  constructor(current: AdminConfigRevisionResponseDto, options: SystemConfigDraftOptions) {
    this.#options = options;
    this.defaults = cloneConfig(options.defaults);
    this.#adopt(current);
  }

  /** Opens the settings bar's review of every pending change. */
  requestReview() {
    this.reviewRequests++;
  }

  get dirty() {
    return this.changes.length > 0;
  }

  get stale() {
    return this.latest !== null;
  }

  /** The configuration groups the draft changes. */
  get changedKeys() {
    return changedConfigKeys(this.changes);
  }

  #snapshot(): AdminConfigDto {
    return $state.snapshot(this.draft) as AdminConfigDto;
  }

  #adopt(current: AdminConfigRevisionResponseDto) {
    const config = cloneConfig(current.config);
    this.baseline = config;
    this.draft = cloneConfig(config);
    this.revision = current.revision;
    this.latest = null;
    this.conflicts = [];
  }

  /** Values the server keeps on its own (the re-queue reminder) change without a new revision. */
  #takeServerManaged(config: AdminConfigDto) {
    const baseline = cloneConfig(this.baseline);
    let changed = false;
    for (const path of SERVER_MANAGED_CONFIG_PATHS) {
      const value = get(config, path) as unknown;
      if (!isEqual(get(baseline, path), value)) {
        set(baseline, path, cloneConfig(value));
        set(this.draft, path, cloneConfig(value));
        changed = true;
      }
    }
    if (changed) {
      this.baseline = baseline;
      this.#updated();
    }
  }

  #clearMessages() {
    this.error = null;
    this.notice = null;
  }

  #updated() {
    this.#options.onUpdated?.(cloneConfig(this.baseline));
  }

  /** Settings pages register confirmations and fix-ups that must run before a save. */
  registerGuard(guard: SystemConfigSaveGuard) {
    this.#guards.add(guard);
    return () => {
      this.#guards.delete(guard);
    };
  }

  dismissNotice() {
    this.notice = null;
  }

  /** "Discard": back to the saved settings. A stale draft takes the newest saved settings. */
  discard() {
    if (this.latest) {
      this.#adopt(this.latest);
      this.#updated();
    } else {
      this.draft = cloneConfig(this.baseline);
    }
    this.error = null;
    this.notice = { code: 'discarded' };
    this.clearJournal();
  }

  /** "Reset this page": the page's defaults go into the draft; saving applies them. */
  resetSection(keys: readonly (keyof AdminConfigDto)[]) {
    this.draft = resetConfigKeys(this.#snapshot(), this.defaults, keys);
    this.error = null;
    this.notice = { code: 'defaults_restored' };
  }

  /**
   * Newer saved settings from outside this draft (another administrator, or a resource action
   * that wrote a setting). A clean draft takes them. A draft whose changes do not overlap is
   * carried onto them. Overlapping changes make the draft stale: nothing is replaced until the
   * administrator reviews the conflicts.
   */
  follow(latest: AdminConfigRevisionResponseDto) {
    if (latest.revision === (this.latest?.revision ?? this.revision)) {
      this.#takeServerManaged(latest.config);
      return;
    }

    if (!this.dirty) {
      this.#adopt(latest);
      this.#updated();
      return;
    }

    const snapshot = this.#snapshot();
    const latestConfig = cloneConfig(latest.config);
    const { draft, conflicts } = rebaseDraft(this.baseline, snapshot, latestConfig);
    // Conflicts found earlier (for example after a reload) stay until the administrator settles them.
    for (const earlier of this.conflicts) {
      const theirs = get(latestConfig, earlier.path) as unknown;
      const mine = get(snapshot, earlier.path) as unknown;
      if (conflicts.every(({ path }) => path !== earlier.path) && !isEqual(theirs, mine)) {
        conflicts.push({ ...earlier, mine, theirs });
      }
    }
    if (conflicts.length > 0) {
      this.latest = latest;
      this.conflicts = conflicts;
      return;
    }

    this.baseline = cloneConfig(latest.config);
    this.draft = draft;
    this.revision = latest.revision;
    this.latest = null;
    this.conflicts = [];
    this.notice = { code: 'rebased' };
    this.#updated();
  }

  /**
   * Loads the saved settings and follows them. A request made while one is running loads again
   * once it finishes; an answer overtaken by a save or a newer load is dropped.
   */
  async refresh(): Promise<boolean> {
    if (this.loading) {
      this.#refreshAgain = true;
      return false;
    }

    this.loading = true;
    try {
      let followed = false;
      do {
        this.#refreshAgain = false;
        const generation = ++this.#generation;
        const latest = await this.#options.load();
        if (generation === this.#generation) {
          this.follow(latest);
          followed = true;
        }
      } while (this.#refreshAgain);
      return followed;
    } catch (error) {
      this.error = { code: 'load_failed', detail: getServerErrorMessage(error) };
      return false;
    } finally {
      this.loading = false;
    }
  }

  /** "Keep my changes": after reviewing the conflicts, the draft's values win on the newest settings. */
  keepMine() {
    const latest = this.latest;
    if (!latest) {
      return;
    }

    const { draft } = rebaseDraft(this.baseline, this.#snapshot(), cloneConfig(latest.config), { force: true });
    this.baseline = cloneConfig(latest.config);
    this.draft = draft;
    this.revision = latest.revision;
    this.latest = null;
    this.conflicts = [];
    this.error = null;
    this.notice = { code: 'kept_mine' };
    this.#updated();
  }

  /** "Discard this draft and load latest". */
  async loadLatest(): Promise<boolean> {
    if (this.loading) {
      return false;
    }

    this.loading = true;
    try {
      this.#generation++;
      this.#adopt(await this.#options.load());
      this.error = null;
      this.notice = { code: 'latest_loaded' };
      this.clearJournal();
      this.#updated();
      return true;
    } catch (error) {
      this.error = { code: 'load_failed', detail: getServerErrorMessage(error) };
      return false;
    } finally {
      this.loading = false;
    }
  }

  async #runGuards() {
    const changed = this.changedKeys;
    for (const guard of this.#guards) {
      if (guard.keys.some((key) => changed.has(key)) && !(await guard.beforeSave())) {
        return false;
      }
    }
    return true;
  }

  async #failed(error: unknown, code: 'save_failed' | 'partial_save_failed') {
    if (isSystemConfigConflict(error)) {
      // Keep the draft. Load what is saved now: a draft that does not overlap is carried onto it
      // (the administrator saves again); an overlapping one is marked stale for review.
      this.error = null;
      await this.refresh();
      return;
    }
    this.error = { code, detail: getServerErrorMessage(error) };
  }

  /** Saves the whole draft; resolves true when the settings were saved. */
  async save(): Promise<boolean> {
    if (!this.dirty || this.saving || this.stale) {
      return false;
    }

    this.#clearMessages();
    this.saving = true;
    try {
      if (!(await this.#runGuards())) {
        return false;
      }
      const sent = this.#snapshot();
      this.#generation++;
      const response = await this.#options.save({ config: sent, expectedRevision: this.revision });
      this.#generation++;
      // Edits made while the save was on its way stay in the draft, on top of what was saved.
      const { draft } = rebaseDraft(sent, this.#snapshot(), cloneConfig(response.config), { force: true });
      this.baseline = cloneConfig(response.config);
      this.draft = draft;
      this.revision = response.revision;
      this.latest = null;
      this.conflicts = [];
      this.notice = { code: 'saved' };
      if (!this.dirty) {
        this.clearJournal();
      }
      this.#updated();
      return true;
    } catch (error) {
      await this.#failed(error, 'save_failed');
      return false;
    } finally {
      this.saving = false;
    }
  }

  /**
   * Saves only the given groups of the draft (the email delivery test saves the email settings).
   * Every other pending change stays in the draft, carried onto the saved result.
   */
  async saveKeys(keys: readonly (keyof AdminConfigDto)[]): Promise<boolean> {
    if (this.saving || this.stale) {
      return false;
    }

    const payload = pickConfigKeys(this.baseline, this.#snapshot(), keys);
    if (!configKeysDiffer(payload, this.baseline, keys)) {
      return true;
    }

    this.#clearMessages();
    this.saving = true;
    try {
      this.#generation++;
      const response = await this.#options.save({ config: payload, expectedRevision: this.revision });
      this.#generation++;
      // The saved groups are no longer pending; the rest of the draft is carried onto the result.
      const { draft } = rebaseDraft(payload, this.#snapshot(), cloneConfig(response.config), { force: true });
      this.baseline = cloneConfig(response.config);
      this.draft = draft;
      this.revision = response.revision;
      this.latest = null;
      this.conflicts = [];
      this.notice = { code: 'partial_saved' };
      this.#updated();
      return true;
    } catch (error) {
      await this.#failed(error, 'partial_save_failed');
      return false;
    } finally {
      this.saving = false;
    }
  }

  /**
   * Takes a settings file into the draft. Nothing is saved: the administrator reviews the result.
   * Leaves this server does not have are reported and ignored.
   */
  importFile(text: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.error = { code: 'invalid_file', detail: error instanceof Error ? error.message : undefined };
      return false;
    }

    try {
      const result = importConfig(this.#snapshot(), parsed);
      this.draft = result.draft;
      this.error = null;
      this.notice = {
        code: 'imported',
        applied: result.applied.length,
        unsupported: result.unsupported,
        keptSecrets: result.keptSecrets.length,
        skippedSecrets: result.skippedSecrets.length,
      };
      return true;
    } catch (error) {
      this.error = { code: 'invalid_file', detail: error instanceof Error ? error.message : undefined };
      return false;
    }
  }

  /** Writes the reload journal (called whenever the draft changes). */
  persistJournal() {
    const storage = this.#options.storage;
    if (!storage) {
      return;
    }

    try {
      if (!this.dirty) {
        storage.remove();
        this.unjournaled = 0;
        return;
      }
      // A conflicting change keeps the value it was first made against, so a later reload still
      // finds the conflict instead of quietly taking the draft's value.
      const changes = this.changes.map((change) => {
        const conflict = this.conflicts.find(({ path }) => path === change.path);
        return conflict ? { ...change, before: conflict.before } : change;
      });
      const { journal, skipped } = createJournal(this.revision, changes);
      this.unjournaled = skipped;
      if (journal.changes.length === 0) {
        storage.remove();
      } else {
        storage.write(JSON.stringify(journal));
      }
      this.journalAvailable = true;
    } catch {
      this.journalAvailable = false;
    }
  }

  clearJournal() {
    try {
      this.#options.storage?.remove();
    } catch {
      this.journalAvailable = false;
    }
    this.unjournaled = 0;
  }

  /**
   * Recovers a draft journaled before a reload. Changes whose setting was changed to something
   * else since are kept in the draft and reported as conflicts for review.
   */
  recover(): boolean {
    const storage = this.#options.storage;
    if (!storage) {
      return false;
    }

    let raw: string | null;
    try {
      raw = storage.read();
    } catch {
      this.journalAvailable = false;
      return false;
    }

    const journal = parseJournal(raw);
    if (!journal) {
      this.clearJournal();
      return false;
    }

    const { draft, recovered, conflicts, dropped } = recoverJournal(this.baseline, journal);
    if (recovered === 0) {
      this.clearJournal();
      return false;
    }

    this.draft = draft;
    if (conflicts.length > 0) {
      this.latest = { config: cloneConfig(this.baseline), revision: this.revision };
      this.conflicts = conflicts;
    }
    this.notice = { code: 'recovered', count: recovered, dropped };
    return true;
  }
}

const CONTEXT_KEY = Symbol('frameleaf-system-config-draft');

/** Called by the settings page; every settings form below it edits this one draft. */
export const setSystemConfigDraft = (store: SystemConfigDraftStore) => setContext(CONTEXT_KEY, store);

/** The settings page's draft, or undefined when a form is used on its own (onboarding). */
export const getSystemConfigDraft = () => getContext<SystemConfigDraftStore | undefined>(CONTEXT_KEY);

/** For forms that only exist on the settings page. */
export const requireSystemConfigDraft = () => {
  const store = getSystemConfigDraft();
  if (!store) {
    throw new Error('Settings forms must be rendered inside the settings page');
  }
  return store;
};
