import { importResult, planEagleImport, reconciles, type EagleLibrary } from '$lib/frameleaf/eagle/eagle-import';
import type { EagleImportApi } from '$lib/frameleaf/eagle/eagle-import-api';
import { memoryEagleImportStore, type EagleImportStore } from '$lib/frameleaf/eagle/eagle-import-record';
import { EagleImportRun, isSameLibrary } from '$lib/frameleaf/eagle/eagle-import-run.svelte';
import { readEagleLibrary } from '$lib/frameleaf/eagle/eagle-library-reader';
import { FIXTURE_LIBRARY_NAME, fixtureLibraryEntries } from '$lib/frameleaf/eagle/eagle-library.fixture';

/** A server in memory: files already in the library are found by name, as the upload path finds them by contents. */
function fakeApi({ existing = new Set<string>(), failing = new Set<string>() } = {}) {
  let next = 0;
  const collections: { id: string; name: string; parentId?: string; color?: string; description?: string }[] = [];
  const uploads: string[] = [];
  const albumAssets = new Map<string, string[]>();
  const tags = new Map<string, string[]>();
  const updates = new Map<string, { rating?: number; description?: string }>();
  const library = new Map<string, string>();
  const sources = new Map<string, string[]>();
  const added = new Map<string, Date>();
  /** When each item came into the library. Items already there came in long before the import. */
  const addedAt = new Map<string, string>();
  for (const name of existing) {
    library.set(name, `existing-${name}`);
    addedAt.set(`existing-${name}`, '2020-01-01T00:00:00.000Z');
  }
  const api: EagleImportApi = {
    createCollection: vi.fn((input) => {
      const id = `album-${++next}`;
      collections.push({ id, ...input });
      return Promise.resolve(id);
    }),
    upsertTags: vi.fn((names: string[]) =>
      Promise.resolve(Object.fromEntries(names.map((name) => [name, `tag-${name}`]))),
    ),
    upload: vi.fn((file: File) => {
      uploads.push(file.name);
      if (failing.has(file.name)) {
        return Promise.resolve(undefined);
      }
      const known = library.get(file.name);
      if (known) {
        return Promise.resolve({ assetId: known, duplicate: true });
      }
      const assetId = `asset-${file.name}`;
      library.set(file.name, assetId);
      addedAt.set(assetId, new Date().toISOString());
      return Promise.resolve({ assetId, duplicate: false });
    }),
    describe: vi.fn((assetId: string) =>
      Promise.resolve({ rating: 4, description: '', addedAt: addedAt.get(assetId) ?? new Date().toISOString() }),
    ),
    addToCollections: vi.fn((albumIds: string[], assetId: string) => {
      for (const albumId of albumIds) {
        albumAssets.set(albumId, [...(albumAssets.get(albumId) ?? []), assetId]);
      }
      return Promise.resolve();
    }),
    tag: vi.fn((assetId: string, tagIds: string[]) => {
      tags.set(assetId, tagIds);
      return Promise.resolve();
    }),
    update: vi.fn((assetId: string, changes: { rating?: number; description?: string }) => {
      updates.set(assetId, changes);
      return Promise.resolve();
    }),
    addSource: vi.fn((assetId: string, pageUrl: string) => {
      sources.set(assetId, [...new Set([...(sources.get(assetId) ?? []), pageUrl])]);
      return Promise.resolve();
    }),
    setAdded: vi.fn((assetId: string, date: Date) => {
      added.set(assetId, date);
      addedAt.set(assetId, date.toISOString());
      return Promise.resolve();
    }),
  };
  return { api, collections, uploads, albumAssets, tags, updates, library, sources, added };
}

describe('EagleImportRun', () => {
  let library: EagleLibrary;
  let store: EagleImportStore;
  const supported = new Set(['jpg', 'png', 'svg', 'mp4', 'webp']);
  beforeEach(async () => {
    library = await readEagleLibrary(FIXTURE_LIBRARY_NAME, fixtureLibraryEntries());
    store = memoryEagleImportStore();
  });
  const run = (api: EagleImportApi, options: Partial<ConstructorParameters<typeof EagleImportRun>[0]> = {}) =>
    new EagleImportRun({
      library,
      ownerId: 'user-1',
      target: { mode: 'inside', inside: 'new' },
      existingTop: [],
      supported,
      api,
      store,
      concurrency: 1,
      ...options,
    });

  it('imports into a new "Studio References", nested and coloured as in Eagle', async () => {
    const server = fakeApi({ existing: new Set(['already.png']) });
    const importing = run(server.api);
    await importing.start();

    expect(importing.state).toBe('finished');
    const byName = Object.fromEntries(server.collections.map((album) => [album.name, album]));
    expect(byName['Studio References'].parentId).toBeUndefined();
    expect(byName['Brand identity']).toMatchObject({
      parentId: byName['Studio References'].id,
      color: 'green',
      description: 'Marks we keep coming back to',
    });
    expect(byName['Hero sections']).toMatchObject({ parentId: byName['Landing pages'].id, color: 'amber' });
    expect(byName['Inspiration'].color).toBe('amber');
    expect(server.collections).toHaveLength(8);

    // In two folders: in two collections, stored once.
    expect(server.uploads.filter((name) => name === 'hero.jpg')).toHaveLength(1);
    expect(server.albumAssets.get(byName['Hero sections'].id)).toContain('asset-hero.jpg');
    expect(server.albumAssets.get(byName['Inspiration'].id)).toContain('asset-hero.jpg');
    // Not in a folder: into the chosen collection.
    expect(server.albumAssets.get(byName['Studio References'].id)).toEqual(['asset-loose.webp']);
    expect(server.tags.get('asset-hero.jpg')).toEqual(['tag-hero', 'tag-warm']);
    expect(server.updates.get('asset-hero.jpg')).toEqual({ rating: 5, description: 'Keep for the lodge refresh.' });
    // Already in the library with a rating of its own: the note is added, the rating kept.
    expect(server.updates.get('existing-already.png')).toEqual({ description: 'From Eagle' });

    const plan = planEagleImport(library, { supported, existing: new Set(['I6']) });
    const result = importResult(plan, library, {
      outcomes: importing.outcomes,
      failed: importing.failed,
      collections: importing.collections,
      stopped: false,
      supported,
    });
    expect(result).toMatchObject({ added: 5, already: 1, notReached: 0 });
    expect(reconciles(plan, result)).toBe(true);
    expect((await store.get(importing.key))?.record.status).toBe('finished');
  });

  it('brings web addresses over as sources and the date changed in Eagle as the Added date', async () => {
    const server = fakeApi({ existing: new Set(['already.png']) });
    const importing = run(server.api);
    await importing.start();

    expect(Object.fromEntries(server.sources)).toEqual({
      'asset-hero.jpg': ['https://gallery.example.test/shot/1'],
      'asset-loop.mp4': ['https://gallery.example.test/clip'],
      'asset-loose.webp': ['https://gallery.example.test/loose'],
    });
    const changedInEagle = new Date(1_789_000_000_000);
    expect(new Set(server.added.keys())).toEqual(
      new Set(['asset-display.svg', 'asset-hero.jpg', 'asset-logo.png', 'asset-loop.mp4', 'asset-loose.webp']),
    );
    for (const date of server.added.values()) {
      expect(date.getTime()).toBe(changedInEagle.getTime());
    }
    // Already in the library before the import: it keeps its own Added date.
    expect(server.added.has('existing-already.png')).toBe(false);

    const plan = planEagleImport(library, { supported, existing: new Set(['I6']) });
    const result = importResult(plan, library, {
      outcomes: importing.outcomes,
      failed: importing.failed,
      collections: importing.collections,
      stopped: false,
      supported,
    });
    expect(result.sources).toBe(plan.sources);
    expect(reconciles(plan, result)).toBe(true);
  });

  it('sets the Added date of an item an earlier run sent but did not record', async () => {
    const server = fakeApi();
    const first = run(server.api);
    const upload = server.api.upload;
    let sent = 0;
    // The tab closes just after the second file reached the server, before it was filed.
    server.api.upload = (file, checksums) =>
      ++sent === 2 ? upload(file, checksums).then(() => new Promise(() => {})) : upload(file, checksums);
    void first.start();
    await vi.waitFor(() => expect(sent).toBe(2));
    const [paused] = await store.unfinished('user-1');
    expect(Object.keys(paused.outcomes)).toHaveLength(1);
    const unrecorded = `asset-${server.uploads[1]}`;
    expect(server.added.has(unrecorded)).toBe(false);

    server.api.upload = upload;
    await run(server.api, { saved: paused }).start();
    expect(server.added.get(unrecorded)?.getTime()).toBe(1_789_000_000_000);
  });

  it('keeps the item when the server refuses its Added date', async () => {
    const server = fakeApi();
    server.api.setAdded = vi.fn(() => Promise.reject(new Error('400')));
    const importing = run(server.api);
    await importing.start();
    expect(importing.state).toBe('finished');
    expect(importing.failed.size).toBe(0);
    expect(importing.done).toBe(6);
  });

  it('lists an item again when its source could not be recorded, and adds it once when carrying on', async () => {
    const server = fakeApi();
    const addSource = server.api.addSource;
    server.api.addSource = vi.fn(() => Promise.reject(new Error('offline')));
    const first = run(server.api);
    await first.start();
    expect(new Set(first.failed)).toEqual(new Set(['I1', 'I4', 'I5']));
    server.api.addSource = addSource;
    await run(server.api, { saved: await store.get(first.key) }).start();
    expect(server.sources.get('asset-hero.jpg')).toEqual(['https://gallery.example.test/shot/1']);
  });

  it('leaves unfiled items unfiled and renames clashing top folders at the top level', async () => {
    const server = fakeApi();
    await run(server.api, { target: { mode: 'top' }, existingTop: ['Web'] }).start();
    expect(server.collections.map(({ name }) => name)).toContain('Web (Eagle)');
    expect(server.collections.find(({ name }) => name === 'Web (Eagle)')?.parentId).toBeUndefined();
    expect([...server.albumAssets.values()].flat()).not.toContain('asset-loose.webp');
  });

  it('stops after the item being sent, keeping what is done, and carries on without sending anything twice', async () => {
    const server = fakeApi();
    const first = run(server.api);
    let sent = 0;
    const upload = server.api.upload;
    server.api.upload = (file, checksums) => {
      if (++sent === 2) {
        first.stop();
      }
      return upload(file, checksums);
    };
    await first.start();
    expect(first.state).toBe('stopped');
    expect(first.done).toBe(2);
    const saved = await store.get(first.key);
    expect(saved?.record.status).toBe('stopped');
    expect(Object.keys(saved!.outcomes)).toHaveLength(2);

    server.api.upload = upload;
    const before = server.uploads.length;
    const second = run(server.api, { saved });
    expect(second.done).toBe(2);
    await second.start();
    expect(second.state).toBe('finished');
    expect(second.done).toBe(6);
    expect(server.uploads.slice(before)).toHaveLength(4);
    expect(new Set(server.uploads).size).toBe(server.uploads.length);
    // The collections from the first run are reused, not made again.
    expect(server.collections).toHaveLength(8);
  });

  it('treats a run the tab left part-way as one to carry on', async () => {
    const server = fakeApi();
    const first = run(server.api);
    const upload = server.api.upload;
    let sent = 0;
    // The tab closes during the third file: nothing after it runs.
    server.api.upload = (file, checksums) => (++sent === 3 ? new Promise(() => {}) : upload(file, checksums));
    void first.start();
    await vi.waitFor(() => expect(sent).toBe(3));
    const [paused] = await store.unfinished('user-1');
    expect(paused.record.status).toBe('running');
    expect(Object.keys(paused.outcomes)).toHaveLength(2);

    server.api.upload = upload;
    const second = run(server.api, { saved: paused });
    await second.start();
    expect(second.done).toBe(6);
    expect(server.uploads.filter((name) => name === server.uploads[0])).toHaveLength(1);
  });

  it('lists a file that could not be sent and tries it again when carrying on', async () => {
    const server = fakeApi({ failing: new Set(['logo.png']) });
    const first = run(server.api);
    await first.start();
    expect(first.state).toBe('finished');
    expect([...first.failed]).toEqual(['I2']);
    const saved = await store.get(first.key);
    expect(saved?.record.status).toBe('stopped');

    const plan = planEagleImport(library, { supported });
    const result = importResult(plan, library, {
      outcomes: first.outcomes,
      failed: first.failed,
      collections: first.collections,
      stopped: false,
      supported,
    });
    expect(result.failed).toEqual(['logo.png']);
    expect(reconciles(plan, result)).toBe(true);

    const fixed = fakeApi();
    const second = run(fixed.api, { saved });
    await second.start();
    expect(fixed.uploads).toEqual(['logo.png']);
    expect(second.done).toBe(6);
  });

  it('writes annotations only when they can be written', async () => {
    const server = fakeApi();
    const annotate = vi.fn(() => Promise.resolve());
    await run({ ...server.api, annotate }).start();
    expect(annotate).not.toHaveBeenCalled();

    store = memoryEagleImportStore();
    await run({ ...fakeApi().api, annotate }, { annotations: true }).start();
    expect(annotate).toHaveBeenCalledWith('asset-hero.jpg', [
      expect.objectContaining({ kind: 'rect', origin: 'eagle' }),
    ]);
  });

  it('stops before the next item once another account is signed in', async () => {
    const server = fakeApi();
    let signedIn = true;
    // The account changes once the first item is in Boards.
    const saveOutcome = store.saveOutcome;
    store.saveOutcome = (key, itemId, outcome) => {
      signedIn = false;
      return saveOutcome(key, itemId, outcome);
    };
    const importing = run(server.api, { isCurrent: () => signedIn });
    await importing.start();
    expect(importing.state).toBe('stopped');
    expect(server.uploads).toHaveLength(1);
    expect(importing.done).toBe(1);
  });

  it('writes nothing for an item once the account changes while its file is being sent', async () => {
    const server = fakeApi();
    let signedIn = true;
    const importing = run(server.api, { isCurrent: () => signedIn });
    const upload = server.api.upload;
    server.api.upload = async (file, checksums) => {
      const sent = await upload(file, checksums);
      signedIn = false;
      return sent;
    };
    await importing.start();
    expect(importing.state).toBe('stopped');
    expect(server.uploads).toHaveLength(1);
    expect(server.api.addToCollections).not.toHaveBeenCalled();
    expect(server.api.tag).not.toHaveBeenCalled();
    expect(server.api.update).not.toHaveBeenCalled();
    expect(importing.done).toBe(0);
    expect(importing.failed.size).toBe(0);
  });

  it('writes no rating or note once the account changes while reading an item already here', async () => {
    const server = fakeApi({ existing: new Set(['already.png']) });
    let signedIn = true;
    server.api.describe = vi.fn(() => {
      signedIn = false;
      return Promise.resolve({ rating: null, description: '', addedAt: '2020-01-01T00:00:00.000Z' });
    });
    const importing = run(server.api, { isCurrent: () => signedIn });
    await importing.start();
    expect(server.api.describe).toHaveBeenCalledWith('existing-already.png');
    expect(server.updates.has('existing-already.png')).toBe(false);
    expect(Object.hasOwn(importing.outcomes, 'I6')).toBe(false);
    expect(importing.failed.has('I6')).toBe(false);
    expect(importing.state).toBe('stopped');
  });

  it('makes no tags once the account changes', async () => {
    const server = fakeApi();
    let signedIn = true;
    const createCollection = server.api.createCollection;
    server.api.createCollection = (input) => {
      signedIn = false;
      return createCollection(input);
    };
    const importing = run(server.api, { isCurrent: () => signedIn });
    await importing.start();
    expect(importing.state).toBe('stopped');
    expect(server.api.upsertTags).not.toHaveBeenCalled();
    expect(server.uploads).toHaveLength(0);
  });

  it('leaves an upload cancelled by an account change unrecorded, not failed', async () => {
    const server = fakeApi();
    let signedIn = true;
    server.api.upload = vi.fn(() => {
      signedIn = false;
      return Promise.resolve(undefined);
    });
    const importing = run(server.api, { isCurrent: () => signedIn });
    await importing.start();
    expect(importing.state).toBe('stopped');
    expect(importing.failed.size).toBe(0);
    expect(importing.done).toBe(0);
    expect(server.api.upload).toHaveBeenCalledTimes(1);
  });

  describe('an account change at any point', () => {
    const READS = new Set(['api.describe']);
    /** Every call the import makes to the server and the record store, in order, during one full run. */
    const instrumented = (flipAt: number) => {
      const server = fakeApi({ existing: new Set(['already.png']) });
      const calls: { name: string; afterSwitch: boolean }[] = [];
      let signedIn = true;
      const wrap = <T extends object>(target: T, prefix: string) => {
        for (const [name, value] of Object.entries(target)) {
          if (typeof value === 'function') {
            const original = value as (...args: unknown[]) => Promise<unknown>;
            Object.assign(target, {
              [name]: async (...args: unknown[]) => {
                calls.push({ name: `${prefix}.${name}`, afterSwitch: !signedIn });
                const result = await original(...args);
                if (calls.length === flipAt) {
                  signedIn = false;
                }
                return result;
              },
            });
          }
        }
      };
      const annotate = vi.fn(() => Promise.resolve());
      const api = { ...server.api, annotate };
      wrap(api, 'api');
      const records = memoryEagleImportStore();
      wrap(records, 'store');
      const importing = run(api, { store: records, annotations: true, isCurrent: () => signedIn });
      return { importing, calls };
    };

    it('covers every await point', async () => {
      const { importing, calls } = instrumented(0);
      await importing.start();
      expect(importing.state).toBe('finished');
      // Collections, tags, uploads, filing, tagging, rating and note, source, Added date, annotations
      // and the record.
      expect(new Set(calls.map(({ name }) => name))).toEqual(
        new Set([
          'store.remove',
          'store.save',
          'api.createCollection',
          'api.upsertTags',
          'api.upload',
          'api.addToCollections',
          'api.tag',
          'api.update',
          'api.describe',
          'api.addSource',
          'api.setAdded',
          'api.annotate',
          'store.saveOutcome',
        ]),
      );
    });

    it('writes nothing after the account changes during any of them', async () => {
      const { importing: full, calls: all } = instrumented(0);
      await full.start();
      expect(all.length).toBeGreaterThan(20);
      for (let flipAt = 1; flipAt <= all.length; flipAt++) {
        store = memoryEagleImportStore();
        const { importing, calls } = instrumented(flipAt);
        await importing.start();
        const writesAfter = calls.filter(({ name, afterSwitch }) => afterSwitch && !READS.has(name));
        expect({ flipAt, writesAfter }).toEqual({ flipAt, writesAfter: [] });
        // A change during the very last write (the finished record) leaves nothing to stop.
        const expected = flipAt < all.length ? 'stopped' : 'finished';
        expect({ flipAt, state: importing.state }).toEqual({ flipAt, state: expected });
        expect(importing.error).toBeUndefined();
        expect(importing.failed.size).toBe(0);
      }
    });
  });

  it('does not carry on into another library with the same name', async () => {
    const server = fakeApi();
    const first = run(server.api);
    let sent = 0;
    const upload = server.api.upload;
    server.api.upload = (file, checksums) => {
      if (++sent === 2) {
        first.stop();
      }
      return upload(file, checksums);
    };
    await first.start();
    const saved = await store.get(first.key);
    expect(Object.keys(saved!.outcomes)).toHaveLength(2);

    const other = await readEagleLibrary(FIXTURE_LIBRARY_NAME, fixtureLibraryEntries({ folderPrefix: 'G' }));
    expect(isSameLibrary(saved!, other)).toBe(false);
    expect(isSameLibrary(saved!, library)).toBe(true);
    const fresh = fakeApi();
    const second = run(fresh.api, { library: other, saved });
    // Nothing from the first library is reused: no items are counted done, no collections reused.
    expect(second.done).toBe(0);
    await second.start();
    expect(second.state).toBe('finished');
    expect(fresh.uploads).toHaveLength(6);
    expect(fresh.collections).toHaveLength(8);
    const replaced = await store.get(second.key);
    expect(replaced?.record.fingerprint).toBe(other.fingerprint);
    expect(Object.values(replaced!.outcomes).every(({ assetId }) => assetId.startsWith('asset-'))).toBe(true);
    expect(replaced!.record.albums.G1).toBeDefined();
    expect(replaced!.record.albums.F1).toBeUndefined();
  });

  it('keeps importing when the record cannot be written', async () => {
    const server = fakeApi();
    const failing: EagleImportStore = {
      ...memoryEagleImportStore(),
      save: () => Promise.reject(new Error('blocked')),
      saveOutcome: () => Promise.reject(new Error('blocked')),
    };
    const importing = run(server.api, { store: failing });
    await importing.start();
    expect(importing.error).toBeUndefined();
    expect(importing.state).toBe('finished');
    expect(importing.done).toBe(6);
    expect(importing.failed.size).toBe(0);
  });

  it('replaces the rows of an earlier import of the same library when starting afresh', async () => {
    const server = fakeApi();
    const key = 'user-1:Fixture.library';
    await store.save({
      key,
      ownerId: 'user-1',
      libraryName: FIXTURE_LIBRARY_NAME,
      target: { mode: 'top' },
      albums: {},
      tagIds: {},
      total: 6,
      status: 'finished',
      startedAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    await store.saveOutcome(key, 'I1', { assetId: 'old-asset', duplicate: false });
    await run(server.api).start();
    const saved = await store.get(key);
    expect(saved?.outcomes.I1).toEqual({ assetId: 'asset-hero.jpg', duplicate: false });
    expect(Object.keys(saved!.outcomes)).toHaveLength(6);
  });
});
