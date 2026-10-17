/**
 * The working state of the RAW develop editor (FL-420) across the photographs it has open: each
 * photo's working recipe and undo history, its saved versions on the server and their renders, the
 * selection used for sync and export, and the account's presets.
 *
 * Nothing is stored in the browser. A photo's edits become a version on the server when it is saved
 * (`PUT /assets/:id/develop`, rendered by the server's native RAW engine); until then they are
 * "unsaved changes" that the editor offers to save before it closes.
 */
import {
  cancelAssetDevelopRender,
  createDevelopPreset,
  deleteDevelopPreset,
  getAssetDevelop,
  getDevelopPresets,
  renderAssetDevelopRevision,
  revertAssetDevelop,
  saveAssetDevelop,
  type AssetDevelopResponseDto,
  type AssetDevelopRevisionResponseDto,
  type DevelopPresetResponseDto,
} from '@frameleaf/sdk';
import { followDevelop } from '$lib/frameleaf/develop-api';
import { initialNativeRecipe, isNativeRecipe, nativePreset, type NativeRecipe } from '$lib/frameleaf/native-develop';
import { nativePublicationState } from '$lib/frameleaf/native-editor-state';
import { syncNativeRecipes, type NativeSyncField, type NativeSyncResult } from '$lib/frameleaf/native-sync';
import { applyLook, plain, sameRecipe, sendable, tidy, type Aspect } from '$lib/frameleaf/raw-develop';

export type DevelopPhoto = {
  id: string;
  fileName: string;
  rating: number | null;
  canRate: boolean;
  /** The library already shows an edited version of it. */
  edited: boolean;
};

export type PhotoRecord = {
  status: 'loading' | 'ready' | 'failed';
  error: unknown;
  /** What the sliders show now. */
  recipe: NativeRecipe;
  /** What the current native version holds (the original when there is none). */
  saved: NativeRecipe;
  /** The native version saves build on (`sourceRevisionId`). */
  revisionId: string | undefined;
  currentRevisionId: string | null;
  revisions: AssetDevelopRevisionResponseDto[];
  /** The library shows a version made in another editor; this editor starts from the original. */
  foreign: boolean;
  undo: NativeRecipe[];
  redo: NativeRecipe[];
  aspect: Aspect;
  /** A look just applied, while its strength can still be changed. */
  look: { id: string; base: NativeRecipe; strength: number } | null;
};

const HISTORY_LIMIT = 200;
const COALESCE_MS = 1000;
const snapshot = <T>(value: T): T => plain($state.snapshot(value)) as T;

const emptyRecord = (): PhotoRecord => ({
  status: 'loading',
  error: null,
  recipe: initialNativeRecipe(),
  saved: initialNativeRecipe(),
  revisionId: undefined,
  currentRevisionId: null,
  revisions: [],
  foreign: false,
  undo: [],
  redo: [],
  aspect: 'Original',
  look: null,
});

export type SessionOptions = {
  /** A saved version became the one the library shows. */
  onPublished?: (assetId: string) => void;
  /** Following a render failed (the version itself is unaffected). */
  onFollowError?: (error: unknown) => void;
};

export class RawDevelopSession {
  photos = $state<DevelopPhoto[]>([]);
  activeId = $state('');
  selected = $state<string[]>([]);
  records = $state<Record<string, PhotoRecord>>({});
  presets = $state<DevelopPresetResponseDto[]>([]);
  /** Photos with a save on its way: a second press never stores the same version twice. */
  saving = $state<string[]>([]);

  #follows = new Map<string, () => void>();
  #disposed = false;
  #lastChange: { id: string; key: string; at: number } | undefined;

  constructor(
    photos: DevelopPhoto[],
    initialId: string | undefined,
    private options: SessionOptions = {},
  ) {
    this.photos = photos;
    this.activeId = photos.some((photo) => photo.id === initialId) ? initialId! : (photos[0]?.id ?? '');
  }

  get active(): DevelopPhoto | undefined {
    return this.photos.find((photo) => photo.id === this.activeId);
  }

  get activeIndex() {
    return this.photos.findIndex((photo) => photo.id === this.activeId);
  }

  record(id: string): PhotoRecord {
    return this.records[id] ?? emptyRecord();
  }

  /** Opens a photo, loading its versions the first time. */
  async open(id: string) {
    this.activeId = id;
    if (!this.records[id] || this.records[id].status === 'failed') {
      await this.load(id);
    }
  }

  step(by: 1 | -1) {
    if (this.photos.length === 0) {
      return;
    }
    const next = this.photos[(this.activeIndex + by + this.photos.length) % this.photos.length];
    void this.open(next.id);
  }

  async load(id: string) {
    this.records[id] = { ...emptyRecord(), ...this.records[id], status: 'loading', error: null };
    try {
      const develop = await getAssetDevelop({ id });
      if (this.#disposed) {
        return;
      }
      this.#adopt(id, develop, { resetWorking: true });
      const pending = develop.revisions.find((item) => item.status === 'queued' || item.status === 'rendering');
      if (pending) {
        this.follow(id, pending.id);
      }
    } catch (error) {
      this.records[id] = { ...this.record(id), status: 'failed', error };
    }
  }

  /** Reads the server's versions into the record; `resetWorking` also replaces the working recipe. */
  #adopt(id: string, develop: AssetDevelopResponseDto, { resetWorking }: { resetWorking: boolean }) {
    const record = this.record(id);
    const current = develop.revisions.find((item) => item.id === develop.currentRevisionId);
    const native = current && isNativeRecipe(current.recipe) ? (current.recipe as NativeRecipe) : undefined;
    const saved = native ? tidy(plain(native)) : initialNativeRecipe();
    delete saved.sensorCanvas;
    this.records[id] = {
      ...record,
      status: 'ready',
      error: null,
      revisions: develop.revisions,
      currentRevisionId: develop.currentRevisionId,
      foreign: !!current && !native,
      ...(resetWorking && {
        recipe: plain(saved),
        saved,
        revisionId: native ? current!.id : undefined,
        undo: [],
        redo: [],
        aspect: saved.crop ? 'Free' : 'Original',
        look: null,
      }),
    };
  }

  /**
   * A new working recipe for a photo, as one undo step. Changes to the same control (`coalesce`) in
   * quick succession, a slider being dragged, make one step.
   */
  change(
    id: string,
    next: NativeRecipe,
    { keepLook = false, coalesce }: { keepLook?: boolean; coalesce?: string } = {},
  ) {
    const record = this.records[id];
    if (!record || record.status !== 'ready') {
      return;
    }
    const now = Date.now();
    const last = this.#lastChange;
    const merge = !!coalesce && last?.id === id && last.key === coalesce && now - last.at < COALESCE_MS;
    if (!merge) {
      record.undo = [...record.undo, snapshot(record.recipe)].slice(-HISTORY_LIMIT);
    }
    record.redo = [];
    record.recipe = tidy(next);
    this.#lastChange = coalesce ? { id, key: coalesce, at: now } : undefined;
    if (!keepLook) {
      record.look = null;
    }
  }

  patch(id: string, values: Partial<NativeRecipe>, coalesce?: string) {
    const record = this.records[id];
    if (record) {
      this.change(id, { ...snapshot(record.recipe), ...values }, { coalesce });
    }
  }

  setAspect(id: string, aspect: Aspect) {
    if (this.records[id]) {
      this.records[id].aspect = aspect;
    }
  }

  undo(id: string) {
    const record = this.records[id];
    if (!record?.undo.length) {
      return;
    }
    record.redo = [...record.redo, snapshot(record.recipe)];
    record.recipe = record.undo.at(-1)!;
    record.undo = record.undo.slice(0, -1);
    record.look = null;
  }

  redo(id: string) {
    const record = this.records[id];
    if (!record?.redo.length) {
      return;
    }
    record.undo = [...record.undo, snapshot(record.recipe)];
    record.recipe = record.redo.at(-1)!;
    record.redo = record.redo.slice(0, -1);
    record.look = null;
  }

  /** Applies a look, or changes the strength of the one just applied. */
  look(id: string, lookId: string, strength = 100) {
    const record = this.records[id];
    if (!record || record.status !== 'ready') {
      return;
    }
    const base = record.look ? record.look.base : snapshot(record.recipe);
    this.change(id, applyLook(base, lookId, strength), { keepLook: true, coalesce: `look:${lookId}` });
    record.look = { id: lookId, base, strength };
  }

  isDirty(id: string) {
    const record = this.records[id];
    return !!record && record.status === 'ready' && !sameRecipe(record.recipe, record.saved);
  }

  get dirtyIds() {
    return this.photos.filter((photo) => this.isDirty(photo.id)).map((photo) => photo.id);
  }

  /** The photo shows an edit in the library, or will once saved. */
  isEdited(id: string) {
    const record = this.records[id];
    if (!record || record.status !== 'ready') {
      return !!this.photos.find((photo) => photo.id === id)?.edited;
    }
    return !!record.currentRevisionId || this.isDirty(id);
  }

  /** Saves the working recipe as a new version, rendered by the server, and follows the render. */
  async save(id: string, label?: string): Promise<AssetDevelopRevisionResponseDto | undefined> {
    const record = this.records[id];
    if (!record || record.status !== 'ready' || this.saving.includes(id)) {
      return;
    }
    this.saving = [...this.saving, id];
    try {
      const recipe = sendable(snapshot(record.recipe));
      const result = await saveAssetDevelop({
        id,
        assetDevelopSaveDto: {
          recipe,
          ...(record.revisionId && { sourceRevisionId: record.revisionId }),
          replaceRecipe: true,
          ...(label?.trim() && { label: label.trim() }),
          render: true,
        },
      });
      const current = this.records[id];
      current.revisionId = result.id;
      current.saved = recipe;
      current.revisions = [result, ...current.revisions.filter((item) => item.id !== result.id)];
      this.follow(id, result.id);
      return result;
    } finally {
      this.saving = this.saving.filter((item) => item !== id);
    }
  }

  /** Follows a photo's renders until the target version is shown in the library or stops. */
  follow(id: string, targetId?: string) {
    this.#follows.get(id)?.();
    let notCurrentYet = 0;
    const stop = followDevelop(
      id,
      (develop) => {
        if (this.#disposed || !this.records[id]) {
          return;
        }
        this.#adopt(id, develop, { resetWorking: false });
        const state = nativePublicationState(develop, targetId);
        if (state.awaitingPublication && ++notCurrentYet < 10) {
          return;
        }
        if (state.published || state.terminal || state.awaitingPublication) {
          this.#follows.get(id)?.();
          this.#follows.delete(id);
          if (state.published) {
            this.options.onPublished?.(id);
          }
        }
      },
      {
        onError: (error) => this.options.onFollowError?.(error),
        continueWhile: (develop) => nativePublicationState(develop, targetId).awaitingPublication && notCurrentYet < 10,
      },
    );
    this.#follows.set(id, stop);
  }

  /** Makes a rendered version the one the library shows, or the original when none is named. */
  async revert(id: string, revisionId?: string) {
    const develop = await revertAssetDevelop({ id, assetDevelopRevertDto: revisionId ? { revisionId } : {} });
    this.#adopt(id, develop, { resetWorking: false });
    const record = this.records[id];
    if (revisionId) {
      const revision = develop.revisions.find((item) => item.id === revisionId);
      if (revision && isNativeRecipe(revision.recipe)) {
        record.saved = tidy(plain(revision.recipe as NativeRecipe));
        record.revisionId = revision.id;
      }
    } else {
      record.saved = initialNativeRecipe();
      record.revisionId = undefined;
    }
    if (revisionId) {
      this.follow(id, revisionId);
    } else {
      this.options.onPublished?.(id);
    }
  }

  /** Loads a saved version's settings into the sliders (one undo step); saving builds on it. */
  restore(id: string, revision: AssetDevelopRevisionResponseDto) {
    if (!isNativeRecipe(revision.recipe)) {
      return;
    }
    const recipe = tidy(plain(revision.recipe as NativeRecipe));
    delete recipe.sensorCanvas;
    this.change(id, recipe);
    this.records[id].revisionId = revision.id;
  }

  async render(id: string, revisionId: string) {
    const revision = await renderAssetDevelopRevision({ id, revisionId });
    this.#replaceRevision(id, revision);
    this.follow(id, revisionId);
  }

  async cancel(id: string, revisionId: string) {
    const revision = await cancelAssetDevelopRender({ id, revisionId });
    this.#replaceRevision(id, revision);
  }

  #replaceRevision(id: string, revision: AssetDevelopRevisionResponseDto) {
    const record = this.records[id];
    if (record) {
      record.revisions = record.revisions.map((item) => (item.id === revision.id ? revision : item));
    }
  }

  /**
   * Copies the chosen settings of `source` to `targetIds` as new rendered versions on each. A target's
   * working recipe is replaced by its new version.
   */
  async sync(targetIds: string[], fields: readonly NativeSyncField[], source: NativeRecipe) {
    const results: NativeSyncResult[] = await syncNativeRecipes(targetIds, source, fields);
    await Promise.all(
      results
        .filter((result) => result.status === 'queued')
        .map(async (result) => {
          await this.load(result.assetId);
          if (result.revisionId) {
            this.follow(result.assetId, result.revisionId);
          }
        }),
    );
    return results;
  }

  toggleSelected(id: string) {
    this.selected = this.selected.includes(id) ? this.selected.filter((item) => item !== id) : [...this.selected, id];
  }

  selectAll() {
    this.selected = this.photos.map((photo) => photo.id);
  }

  async loadPresets() {
    this.presets = (await getDevelopPresets()).filter((preset) => !!nativeOf(preset));
  }

  async savePreset(id: string, name: string) {
    const record = this.records[id];
    if (!record) {
      return;
    }
    const preset = await createDevelopPreset({
      developPresetCreateDto: {
        name: name.trim(),
        settings: { native: nativePreset(sendable(record.recipe)) } as never,
      },
    });
    this.presets = [...this.presets, preset];
  }

  async deletePreset(presetId: string) {
    await deleteDevelopPreset({ id: presetId });
    this.presets = this.presets.filter((preset) => preset.id !== presetId);
  }

  /** A preset's settings over the photo's own framing and photo-specific masks. */
  applyPreset(id: string, preset: DevelopPresetResponseDto) {
    const native = nativeOf(preset);
    const record = this.records[id];
    if (!native || !record) {
      return;
    }
    const current = snapshot(record.recipe);
    const ownMasks = (current.masks ?? []).filter((mask) => mask.kind !== 'radial' && mask.kind !== 'linear');
    this.change(id, {
      ...plain(native),
      crop: current.crop,
      rotation: current.rotation,
      straighten: current.straighten,
      flipHorizontal: current.flipHorizontal,
      flipVertical: current.flipVertical,
      masks: [...ownMasks, ...(native.masks ?? [])].slice(0, 8),
    });
  }

  dispose() {
    this.#disposed = true;
    for (const stop of this.#follows.values()) {
      stop();
    }
    this.#follows.clear();
  }
}

export type DevelopTab = 'develop' | 'masks' | 'presets' | 'versions';

/** The editor's tool state, shared by the inspector panels and the photo stage. */
export class DevelopTools {
  tab = $state<DevelopTab>('develop');
  maskId = $state<string | null>(null);
  /** Radial and gradient masks are placed by dragging; painted masks take brush strokes. */
  gesture = $state<'place' | 'brush'>('brush');
  brushMode = $state<'add' | 'subtract'>('add');
  /** Brush width as a fraction of the photo's shorter side. */
  brushSize = $state(0.08);
  overlay = $state(true);
  cropOpen = $state(false);
  compare = $state(false);
  zoom = $state<'fit' | '100' | '150' | '200'>('fit');
  inspectorOpen = $state(false);

  /** A new photo starts on its own masks, out of the crop tool, not comparing. */
  reset() {
    this.maskId = null;
    this.cropOpen = false;
    this.compare = false;
  }
}

export const nativeOf = (preset: DevelopPresetResponseDto) =>
  (preset.settings as unknown as { native?: NativeRecipe }).native;
