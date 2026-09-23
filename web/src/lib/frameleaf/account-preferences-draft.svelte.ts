/**
 * One account preferences draft (FL-77): the unsaved values, the revision they were loaded at,
 * and the save, cancel, reset and load-latest actions of the design template's
 * `AccountPreferences.jsx`. The administrator editor keeps one draft across its three pages; each
 * of an account's own settings groups keeps one for its keys.
 *
 * Every save sends only the changed keys plus `expectedRevision`, so the server refuses (409) a
 * save made against preferences that changed since they were loaded and nothing is overwritten.
 */
import { isHttpError, type UserPreferencesResponseDto, type UserPreferencesUpdateDto } from '@immich/sdk';
import {
  ALL_PREFERENCE_KEYS,
  createDefaultDraft,
  createDraftState,
  followLatestPreferences,
  isDraftDirty,
  preferencesPatch,
  resetSection,
  SECTION_KEYS,
  validateDraft,
  withEmailNotifications,
  type AccountPreferenceKey,
  type AccountPreferencesDraft,
  type AccountPreferencesDraftState,
  type AccountPreferencesEditorRole,
  type AccountPreferencesSection,
  type AccountPreferencesValidationError,
} from '$lib/frameleaf/account-preferences';
import { getServerErrorMessage } from '$lib/utils/handle-error';

export type AccountPreferencesError =
  { code: AccountPreferencesValidationError } | { code: 'save_failed' | 'load_failed'; detail?: string };

export type AccountPreferencesNotice = 'saved' | 'defaults_restored' | 'latest_loaded';

export type AccountPreferencesDraftOptions = {
  role: AccountPreferencesEditorRole;
  /** The keys this draft edits; everything else is never sent. Defaults to every key. */
  keys?: readonly AccountPreferenceKey[];
  /** See `followLatestPreferences`. */
  rebaseUnrelated?: boolean;
  save: (update: UserPreferencesUpdateDto) => Promise<UserPreferencesResponseDto>;
  load: () => Promise<UserPreferencesResponseDto>;
  /** Called with the server's response after a save or a load. */
  onUpdated?: (preferences: UserPreferencesResponseDto) => void;
};

export const isPreferencesConflict = (error: unknown) => isHttpError(error) && error.status === 409;

export class AccountPreferencesDraftStore {
  #state: AccountPreferencesDraftState = $state({
    baseline: createDefaultDraft(),
    draft: createDefaultDraft(),
    revision: '',
    stale: false,
  });
  saving = $state(false);
  loading = $state(false);
  error: AccountPreferencesError | null = $state(null);
  notice: AccountPreferencesNotice | null = $state(null);
  readonly keys: readonly AccountPreferenceKey[];
  #options: AccountPreferencesDraftOptions;

  constructor(preferences: UserPreferencesResponseDto, options: AccountPreferencesDraftOptions) {
    this.#options = options;
    this.keys = options.keys ?? ALL_PREFERENCE_KEYS;
    this.#state = createDraftState(preferences);
  }

  get draft(): AccountPreferencesDraft {
    return this.#state.draft;
  }

  get baseline(): AccountPreferencesDraft {
    return this.#state.baseline;
  }

  get revision() {
    return this.#state.revision;
  }

  get stale() {
    return this.#state.stale;
  }

  get dirty() {
    return isDraftDirty(this.#state.baseline, this.#state.draft, this.keys);
  }

  #clearMessages() {
    this.error = null;
    this.notice = null;
  }

  set<K extends AccountPreferenceKey>(key: K, value: AccountPreferencesDraft[K]) {
    this.#state.draft = { ...this.#state.draft, [key]: value };
    this.#clearMessages();
  }

  setEmailNotifications(enabled: boolean) {
    this.#state.draft = withEmailNotifications(this.#state.draft, enabled);
    this.#clearMessages();
  }

  /** Newer preferences from outside this draft; an unsaved draft is never replaced. */
  follow(latest: UserPreferencesResponseDto) {
    this.#state = followLatestPreferences(this.#state, latest, {
      keys: this.keys,
      rebaseUnrelated: this.#options.rebaseUnrelated,
    });
  }

  /** "Cancel changes": back to the loaded values. */
  cancel() {
    this.#state.draft = { ...this.#state.baseline };
    this.#clearMessages();
  }

  /** "Reset this page": the page's defaults go into the draft; Save applies them. */
  resetSection(section: AccountPreferencesSection) {
    const keys = SECTION_KEYS[section].filter((key) => this.keys.includes(key));
    this.#state.draft = resetSection(this.#state.draft, section, keys);
    this.error = null;
    this.notice = 'defaults_restored';
  }

  /** Saves the changed values; resolves to the server's response, or undefined when nothing was saved. */
  async save(): Promise<UserPreferencesResponseDto | undefined> {
    if (!this.dirty || this.saving) {
      return;
    }

    this.notice = null;
    const { baseline, draft, revision } = this.#state;
    const invalid = validateDraft(baseline, draft, this.keys);
    if (invalid) {
      this.error = { code: invalid };
      return;
    }

    this.saving = true;
    try {
      const update = preferencesPatch(baseline, draft, this.#options.role, this.keys);
      const response = await this.#options.save({ ...update, expectedRevision: revision });
      this.#state = createDraftState(response);
      this.error = null;
      this.notice = 'saved';
      this.#options.onUpdated?.(response);
      return response;
    } catch (error) {
      if (isPreferencesConflict(error)) {
        // Keep the draft; the banner offers to discard it and load the latest preferences.
        this.#state = { ...this.#state, stale: true };
        this.error = null;
      } else {
        this.error = { code: 'save_failed', detail: getServerErrorMessage(error) };
      }
      return;
    } finally {
      this.saving = false;
    }
  }

  /** "Discard draft and load latest". */
  async loadLatest(): Promise<boolean> {
    if (this.loading) {
      return false;
    }

    this.loading = true;
    try {
      const latest = await this.#options.load();
      this.#state = createDraftState(latest);
      this.error = null;
      this.notice = 'latest_loaded';
      this.#options.onUpdated?.(latest);
      return true;
    } catch (error) {
      this.error = { code: 'load_failed', detail: getServerErrorMessage(error) };
      return false;
    } finally {
      this.loading = false;
    }
  }
}
