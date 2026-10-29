import { SvelteSet } from 'svelte/reactivity';
import { EAGLE_ANNOTATIONS_AVAILABLE, eagleAnnotations } from '$lib/frameleaf/eagle/eagle-annotations';
import {
  EAGLE_DEFAULT_COLLECTION,
  eagleColour,
  eagleFileName,
  eagleFolders,
  eagleImportKey,
  isComing,
  topFolderNames,
  type EagleItem,
  type EagleItemOutcome,
  type EagleLibrary,
  type EagleTarget,
} from '$lib/frameleaf/eagle/eagle-import';
import type { EagleImportApi } from '$lib/frameleaf/eagle/eagle-import-api';
import type { EagleImportRecord, EagleImportSaved, EagleImportStore } from '$lib/frameleaf/eagle/eagle-import-record';
import type { EagleRunStatus } from '$lib/frameleaf/eagle/eagle-import-status.svelte';
import type { UploadChecksums } from '$lib/utils/file-uploader';

/** One of the latest items brought over, for the progress list. */
export interface EagleRecentItem {
  id: string;
  name: string;
  duplicate: boolean;
  /** Names of the collections it went into. */
  collections: string[];
}

export interface EagleImportRunOptions {
  library: EagleLibrary;
  ownerId: string;
  target: EagleTarget;
  /** Names of your top-level collections, for "Name (Eagle)" at the top level. */
  existingTop: string[];
  /** The name of the collection chosen to import into (inside an existing one). */
  insideName?: string;
  supported: ReadonlySet<string>;
  api: EagleImportApi;
  store: EagleImportStore;
  /** Checksums from the check, by item id, so files are not read twice. */
  checksums?: ReadonlyMap<string, UploadChecksums>;
  /** The record of an earlier run of this import, to carry on from. */
  saved?: EagleImportSaved;
  concurrency?: number;
  annotations?: boolean;
  now?: () => Date;
  /**
   * Whether the account that started the import is still the one signed in. The import stops
   * before the next item once it isn't, so nothing is sent into another account's library.
   */
  isCurrent?: () => boolean;
}

const TAG_BATCH = 100;
const RECENT = 3;

/** Whether a saved import came from this library, not just one with the same folder name. */
export const isSameLibrary = (saved: EagleImportSaved, library: Pick<EagleLibrary, 'fingerprint'>) =>
  !!saved.record.fingerprint && saved.record.fingerprint === library.fingerprint;

/** The signed-in account changed part-way through an item. */
class AccountChangedError extends Error {
  constructor() {
    super('The signed-in account changed');
    this.name = 'AccountChangedError';
  }
}

/**
 * Runs an Eagle import in this tab. Collections are made first, parents before children, then each
 * item is sent and filed with its tags, rating and note. Every step is written to the record as it
 * finishes, so stopping (or closing the tab) keeps what is done, and carrying on never sends an item
 * the record already has. The Eagle library is only read.
 */
export class EagleImportRun implements EagleRunStatus {
  state = $state<EagleRunStatus['state']>('running');
  done = $state(0);
  readonly total: number;
  outcomes = $state<Record<string, EagleItemOutcome>>({});
  /** Items that could not be sent this time, by Eagle id. Carrying on tries them again. */
  readonly failed = new SvelteSet<string>();
  recent = $state<EagleRecentItem[]>([]);
  collections = $state(0);
  /** Something went wrong before any item could be sent (making the collections or tags). */
  error = $state<unknown>();
  readonly key: string;
  #record: EagleImportRecord;
  #options: EagleImportRunOptions;
  #stopRequested = false;
  /** Writing the record failed; the import carries on, and duplicates are still found on a later run. */
  #persist = true;
  /** The account that started the import is no longer signed in. Once set, nothing more is written. */
  #switched = false;
  #finished: Promise<void> | undefined;
  #collectionNames = new Map<string, string>();

  constructor(options: EagleImportRunOptions) {
    const { library, ownerId, target, supported } = options;
    // A record carries on only into the library it came from. One from a different library with the
    // same name is ignored, and starting replaces it, so its items and collections are never reused.
    const saved = options.saved && isSameLibrary(options.saved, library) ? options.saved : undefined;
    this.#options = { ...options, saved };
    this.key = eagleImportKey(ownerId, library.name);
    const now = (options.now?.() ?? new Date()).toISOString();
    const coming = library.items.filter((item) => isComing(item, supported));
    this.total = coming.length;
    this.#record = saved
      ? { ...saved.record, total: this.total, status: 'running', updatedAt: now }
      : {
          key: this.key,
          ownerId,
          libraryName: library.name,
          fingerprint: library.fingerprint,
          target,
          albums: {},
          tagIds: {},
          total: this.total,
          status: 'running',
          startedAt: now,
          updatedAt: now,
        };
    // Only outcomes for items still in the library count.
    const ids = new Set(coming.map(({ id }) => id));
    this.outcomes = Object.fromEntries(Object.entries(saved?.outcomes ?? {}).filter(([id]) => ids.has(id)));
    this.done = Object.keys(this.outcomes).length;
  }

  /** The collection the import went into, if it went inside one. */
  get rootAlbumId() {
    return this.#record.rootAlbumId;
  }

  get target() {
    return this.#record.target;
  }

  /** Starts the import; resolves when it has finished or stopped. */
  start(): Promise<void> {
    this.#finished ??= this.#run();
    return this.#finished;
  }

  /** Stops after the items being sent now; everything already brought over stays. */
  stop() {
    if (this.state === 'running') {
      this.#stopRequested = true;
      this.state = 'stopping';
    }
  }

  /**
   * Writes the record. It is best-effort: a browser that can't store it (blocked storage, some
   * private windows) still imports, it just can't resume without reading the files again.
   */
  async #save() {
    if (!this.#persist || this.#accountChanged()) {
      return;
    }
    this.#record.updatedAt = (this.#options.now?.() ?? new Date()).toISOString();
    try {
      await this.#options.store.save(this.#record);
    } catch {
      this.#persist = false;
    }
  }

  async #saveOutcome(itemId: string, outcome: EagleItemOutcome) {
    if (!this.#persist || this.#accountChanged()) {
      return;
    }
    try {
      await this.#options.store.saveOutcome(this.key, itemId, outcome);
    } catch {
      this.#persist = false;
    }
  }

  /**
   * A fresh import replaces any earlier record of the same library, so its old per-item rows can't
   * make this run skip items. If they can't be removed, nothing is written for this run, rather
   * than mixing new rows with old ones.
   */
  async #startFresh() {
    if (this.#options.saved || this.#accountChanged()) {
      return;
    }
    try {
      await this.#options.store.remove(this.key);
    } catch {
      this.#persist = false;
    }
  }

  /** Whether the account that started the import has gone. The import then stops for good. */
  #accountChanged() {
    if (!this.#switched && this.#options.isCurrent && !this.#options.isCurrent()) {
      this.#switched = true;
      this.#stopRequested = true;
    }
    return this.#switched;
  }

  /**
   * Every server write goes through here: the account is checked synchronously, after the last
   * await, just before the write starts. Once it has changed nothing more is written, and the item
   * being imported is left unrecorded rather than failed. (Writes to the saved record check the
   * same way in `#save`, `#saveOutcome` and `#startFresh`.)
   */
  #write<T>(write: () => Promise<T>): Promise<T> {
    return this.#accountChanged() ? Promise.reject(new AccountChangedError()) : write();
  }

  /** Whether to start more work: not when the user stopped the import or the account changed. */
  #stillCurrent() {
    return !this.#accountChanged() && !this.#stopRequested;
  }

  async #run() {
    const { library, supported } = this.#options;
    try {
      await this.#startFresh();
      await this.#save();
      await this.#makeCollections();
      const remaining = library.items.filter(
        (item) => isComing(item, supported) && !Object.hasOwn(this.outcomes, item.id),
      );
      await this.#makeTags(remaining);
      await this.#sendAll(remaining);
    } catch (error) {
      if (!(error instanceof AccountChangedError)) {
        this.error = error;
      }
      this.#stopRequested = true;
    }
    const stopped = this.#stopRequested;
    this.#record.status = stopped || this.failed.size > 0 ? 'stopped' : 'finished';
    await this.#save();
    this.state = stopped ? 'stopped' : 'finished';
  }

  async #makeCollections() {
    const { library, existingTop, api, insideName } = this.#options;
    const record = this.#record;
    const { target } = record;
    if (target.mode === 'inside') {
      if (target.inside === 'new') {
        record.rootAlbumId ??= await this.#write(() => api.createCollection({ name: EAGLE_DEFAULT_COLLECTION }));
      } else {
        record.rootAlbumId = target.inside;
      }
      await this.#save();
    }
    const topNames = topFolderNames(library, target, existingTop);
    for (const folder of eagleFolders(library)) {
      const name = folder.parent ? folder.name : (topNames.get(folder.id) ?? folder.name);
      this.#collectionNames.set(folder.id, name);
      if (!this.#stillCurrent()) {
        return;
      }
      if (!Object.hasOwn(record.albums, folder.id)) {
        const parentId = folder.parent ? record.albums[folder.parent] : record.rootAlbumId;
        record.albums[folder.id] = await this.#write(() =>
          api.createCollection({
            name,
            ...(parentId && { parentId }),
            ...(eagleColour(folder.color) && { color: eagleColour(folder.color) }),
            ...(folder.description && { description: folder.description }),
          }),
        );
        await this.#save();
      }
      this.collections = Object.keys(record.albums).length;
    }
    if (target.mode === 'inside') {
      this.#collectionNames.set('', insideName ?? EAGLE_DEFAULT_COLLECTION);
    }
  }

  async #makeTags(items: EagleItem[]) {
    const missing = [...new Set(items.flatMap(({ tags }) => tags))].filter(
      (name) => !Object.hasOwn(this.#record.tagIds, name),
    );
    for (let index = 0; index < missing.length; index += TAG_BATCH) {
      if (!this.#stillCurrent()) {
        return;
      }
      const batch = missing.slice(index, index + TAG_BATCH);
      Object.assign(this.#record.tagIds, await this.#write(() => this.#options.api.upsertTags(batch)));
      await this.#save();
    }
  }

  async #sendAll(items: EagleItem[]) {
    let next = 0;
    const worker = async () => {
      while (this.#stillCurrent() && next < items.length) {
        await this.#send(items[next++]);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.#options.concurrency ?? 3) }, worker));
  }

  async #send(item: EagleItem) {
    const { api, checksums } = this.#options;
    const record = this.#record;
    const { target } = record;
    try {
      const sent = await this.#write(() => api.upload(item.file!, checksums?.get(item.id)));
      if (!sent) {
        // An upload cancelled because the account changed is left unrecorded, not failed.
        if (!this.#accountChanged()) {
          this.failed.add(item.id);
        }
        return;
      }
      const { assetId, duplicate } = sent;
      const filed = item.folders.filter((id) => record.albums[id]);
      const albumIds = filed.map((id) => record.albums[id]);
      if (albumIds.length === 0 && target.mode === 'inside' && record.rootAlbumId) {
        albumIds.push(record.rootAlbumId);
      }
      if (albumIds.length > 0) {
        await this.#write(() => api.addToCollections(albumIds, assetId));
      }
      const tagIds = item.tags.map((name) => record.tagIds[name]).filter(Boolean);
      if (tagIds.length > 0) {
        await this.#write(() => api.tag(assetId, tagIds));
      }
      await this.#describe(item, assetId, duplicate);
      if ((this.#options.annotations ?? EAGLE_ANNOTATIONS_AVAILABLE) && api.annotate) {
        const annotations = eagleAnnotations(item);
        if (annotations.length > 0) {
          const annotate = api.annotate;
          await this.#write(() => annotate(assetId, annotations));
        }
      }
      const outcome = { assetId, duplicate };
      await this.#saveOutcome(item.id, outcome);
      this.outcomes[item.id] = outcome;
      this.failed.delete(item.id);
      this.done++;
      const names = filed.length > 0 ? filed : target.mode === 'inside' ? [''] : [];
      this.recent = [
        {
          id: item.id,
          name: eagleFileName(item),
          duplicate,
          collections: names.map((id) => this.#collectionNames.get(id) ?? '').filter(Boolean),
        },
        ...this.recent,
      ].slice(0, RECENT);
    } catch (error) {
      // An account change leaves the item unrecorded, not failed: the next run finds it and files it.
      if (!(error instanceof AccountChangedError)) {
        this.failed.add(item.id);
      }
    }
  }

  /** Rating and note. An item that was already in the library keeps a rating or note it has. */
  async #describe(item: EagleItem, assetId: string, duplicate: boolean) {
    const note = item.annotation.trim();
    if (item.star <= 0 && !note) {
      return;
    }
    const current = duplicate ? await this.#options.api.describe(assetId) : { rating: null, description: '' };
    const changes = {
      ...(item.star > 0 && !current.rating && { rating: item.star }),
      ...(note && !current.description.trim() && { description: note }),
    };
    if (Object.keys(changes).length > 0) {
      await this.#write(() => this.#options.api.update(assetId, changes));
    }
  }
}
