import type { EagleItemOutcome, EagleTarget } from '$lib/frameleaf/eagle/eagle-import';

/**
 * The resumable record of an Eagle import, kept in this browser (IndexedDB) and keyed by account
 * and library. It holds the collections and tags already made and, for every item brought over,
 * the item it became. Reopening Boards after the tab closed shows "paused at N of M"; choosing the
 * library again carries on from there, and nothing in the record is sent again.
 */
export interface EagleImportRecord {
  key: string;
  ownerId: string;
  libraryName: string;
  target: EagleTarget;
  /** The collection the import went into, when it went inside one. */
  rootAlbumId?: string;
  /** Eagle folder id → collection id. */
  albums: Record<string, string>;
  /** Tag name → tag id. */
  tagIds: Record<string, string>;
  /** Items that come over, as counted by the check. */
  total: number;
  /** `running` that no tab is running is a pause: the tab closed part-way. */
  status: 'running' | 'stopped' | 'finished';
  startedAt: string;
  updatedAt: string;
}

export interface EagleImportSaved {
  record: EagleImportRecord;
  outcomes: Record<string, EagleItemOutcome>;
}

export interface EagleImportStore {
  get(key: string): Promise<EagleImportSaved | undefined>;
  save(record: EagleImportRecord): Promise<void>;
  saveOutcome(key: string, itemId: string, outcome: EagleItemOutcome): Promise<void>;
  /** Imports this account has not finished, newest first. */
  unfinished(ownerId: string): Promise<EagleImportSaved[]>;
  remove(key: string): Promise<void>;
}

const newestFirst = (a: EagleImportSaved, b: EagleImportSaved) => b.record.updatedAt.localeCompare(a.record.updatedAt);

/** An in-memory store, for tests and for browsers without IndexedDB. */
export function memoryEagleImportStore(): EagleImportStore {
  const records = new Map<string, EagleImportRecord>();
  const outcomes = new Map<string, Record<string, EagleItemOutcome>>();
  const read = (key: string): EagleImportSaved | undefined => {
    const record = records.get(key);
    return record && { record: structuredClone(record), outcomes: { ...outcomes.get(key) } };
  };
  return {
    get: (key) => Promise.resolve(read(key)),
    save: (record) => {
      records.set(record.key, structuredClone(record));
      return Promise.resolve();
    },
    saveOutcome: (key, itemId, outcome) => {
      outcomes.set(key, { ...outcomes.get(key), [itemId]: outcome });
      return Promise.resolve();
    },
    unfinished: (ownerId) =>
      Promise.resolve(
        [...records.values()]
          .filter((record) => record.ownerId === ownerId && record.status !== 'finished')
          .map((record) => read(record.key)!)
          .sort(newestFirst),
      ),
    remove: (key) => {
      records.delete(key);
      outcomes.delete(key);
      return Promise.resolve();
    },
  };
}

const DATABASE = 'frameleaf-eagle-import';
const IMPORTS = 'imports';
const ITEMS = 'items';

const request = <T>(value: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    value.addEventListener('success', () => resolve(value.result));
    value.addEventListener('error', () => reject(value.error ?? new Error('IndexedDB request failed')));
  });
const done = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('IndexedDB write failed')));
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('IndexedDB write aborted')));
  });

interface StoredOutcome extends EagleItemOutcome {
  key: string;
  itemId: string;
}

/**
 * The browser store. Each item's outcome is its own row, written as soon as the item is in Boards,
 * so a closed tab loses at most the item that was being sent.
 */
export function indexedDbEagleImportStore(factory: IDBFactory = indexedDB): EagleImportStore {
  let opened: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(DATABASE, 1);
      opening.addEventListener('upgradeneeded', () => {
        const database = opening.result;
        database.createObjectStore(IMPORTS, { keyPath: 'key' }).createIndex('ownerId', 'ownerId');
        database.createObjectStore(ITEMS, { keyPath: ['key', 'itemId'] }).createIndex('key', 'key');
      });
      opening.addEventListener('success', () => resolve(opening.result));
      opening.addEventListener('error', () => {
        opened = undefined;
        reject(opening.error ?? new Error('IndexedDB unavailable'));
      });
    }));

  const readOutcomes = async (database: IDBDatabase, key: string) => {
    const rows = await request<StoredOutcome[]>(
      database.transaction(ITEMS).objectStore(ITEMS).index('key').getAll(IDBKeyRange.only(key)),
    );
    return Object.fromEntries(rows.map(({ itemId, assetId, duplicate }) => [itemId, { assetId, duplicate }]));
  };

  return {
    async get(key) {
      const database = await open();
      const record = await request<EagleImportRecord | undefined>(
        database.transaction(IMPORTS).objectStore(IMPORTS).get(key),
      );
      return record && { record, outcomes: await readOutcomes(database, key) };
    },
    async save(record) {
      const database = await open();
      const transaction = database.transaction(IMPORTS, 'readwrite');
      // IndexedDB stores its own structured clone of the record.
      transaction.objectStore(IMPORTS).put(record);
      await done(transaction);
    },
    async saveOutcome(key, itemId, outcome) {
      const database = await open();
      const transaction = database.transaction(ITEMS, 'readwrite');
      transaction.objectStore(ITEMS).put({ key, itemId, ...outcome } satisfies StoredOutcome);
      await done(transaction);
    },
    async unfinished(ownerId) {
      const database = await open();
      const records = await request<EagleImportRecord[]>(
        database.transaction(IMPORTS).objectStore(IMPORTS).index('ownerId').getAll(IDBKeyRange.only(ownerId)),
      );
      const saved = await Promise.all(
        records
          .filter(({ status }) => status !== 'finished')
          .map(async (record) => ({ record, outcomes: await readOutcomes(database, record.key) })),
      );
      return saved.sort(newestFirst);
    },
    async remove(key) {
      const database = await open();
      const transaction = database.transaction([IMPORTS, ITEMS], 'readwrite');
      transaction.objectStore(IMPORTS).delete(key);
      const items = transaction.objectStore(ITEMS);
      const keys = items.index('key').getAllKeys(IDBKeyRange.only(key));
      // Deleted inside the success callback, so the rows go in the same transaction.
      keys.addEventListener('success', () => {
        for (const primary of keys.result) {
          items.delete(primary);
        }
      });
      await done(transaction);
    },
  };
}

let shared: EagleImportStore | undefined;
/** The store this browser uses: IndexedDB where it works, memory otherwise. */
export const eagleImportStore = (): EagleImportStore =>
  (shared ??= typeof indexedDB === 'undefined' ? memoryEagleImportStore() : indexedDbEagleImportStore());
