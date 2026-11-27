import { AlbumKind, AlbumUserRole, LibraryViewScope } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { railSession } from '$lib/frameleaf/rail-session.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

const rail = (...names: string[]) => ({
  albums: names.map((albumName) => ({
    id: albumName,
    albumName,
    parentId: null,
    kind: AlbumKind.Album,
    icon: null,
    color: null,
    sortOrder: null,
    role: AlbumUserRole.Owner,
    shared: false,
    isLocked: false,
    isSmart: false,
    smartRuleId: null,
    assetCount: 0,
    bookmarkCount: 0,
  })),
});
const hierarchy = (...names: string[]) => ({
  roots: names.map((albumName) => ({
    album: albumFactory.build({ id: albumName, albumName, kind: AlbumKind.Album }),
    children: [],
  })),
});
const names = (scope = '') => railSession.albums[scope]?.records.map(({ albumName }) => albumName);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/** FL-1796: the rail's tree and partners are kept for the session and dropped when access changes. */
describe('railSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authManager.setUser(userAdminFactory.build());
    railSession.reset();
  });
  afterEach(() => authManager.reset());

  it('keeps each workspace its own tree', async () => {
    sdkMock.getAlbumRail.mockResolvedValueOnce(rail('Trips') as never);
    await railSession.refreshAlbums();
    sdkMock.getAlbumRail.mockResolvedValueOnce(rail('Moodboard') as never);
    await railSession.refreshAlbums(LibraryViewScope.Design);

    expect(sdkMock.getAlbumRail).toHaveBeenNthCalledWith(1, {});
    expect(sdkMock.getAlbumRail).toHaveBeenNthCalledWith(2, { libraryScope: LibraryViewScope.Design });
    expect(names()).toEqual(['Trips']);
    expect(names(LibraryViewScope.Design)).toEqual(['Moodboard']);
  });

  it('keeps the newest read asked, whichever answers last', async () => {
    const before = deferred<never>();
    const after = deferred<never>();
    sdkMock.getAlbumRail.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);
    const first = railSession.refreshAlbums();
    const second = railSession.refreshAlbums();
    after.resolve(rail('After the move') as never);
    await second;
    before.resolve(rail('Before the move') as never);
    await first;
    expect(names()).toEqual(['After the move']);
  });

  it('keeps the last tree and reports a failed read', async () => {
    sdkMock.getAlbumRail.mockResolvedValueOnce(rail('Trips') as never);
    await railSession.refreshAlbums();
    sdkMock.getAlbumRail.mockRejectedValueOnce(new Error('offline'));
    await expect(railSession.refreshAlbums()).rejects.toThrow('offline');
    expect(names()).toEqual(['Trips']);
  });

  it.each(['SessionLocked', 'AuthLogout'] as const)(
    'drops everything on %s, and an answer still on its way',
    async (event) => {
      sdkMock.getAlbumRail.mockResolvedValueOnce(rail('Trips') as never);
      sdkMock.getPartners.mockResolvedValueOnce([{ id: 'partner' }] as never);
      await Promise.all([railSession.refreshAlbums(), railSession.refreshPartners()]);
      const late = deferred<never>();
      sdkMock.getAlbumRail.mockReturnValueOnce(late.promise);
      const pending = railSession.refreshAlbums();

      eventManager.emit(event);
      late.resolve(rail('Locked album') as never);
      await pending;

      expect(railSession.albums).toEqual({});
      expect(railSession.partners).toBeUndefined();
    },
  );

  it('forgets one workspace before a change that may take albums away', async () => {
    sdkMock.getAlbumRail.mockResolvedValue(rail('Trips') as never);
    await railSession.refreshAlbums();
    await railSession.refreshAlbums(LibraryViewScope.Design);
    railSession.dropAlbums();
    expect(names()).toBeUndefined();
    expect(names(LibraryViewScope.Design)).toEqual(['Trips']);
  });

  it('reads the partners again when one stops sharing, and shows none after a failed read', async () => {
    sdkMock.getPartners.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }] as never);
    await railSession.refreshPartners();
    expect(railSession.partners).toHaveLength(2);

    sdkMock.getPartners.mockResolvedValueOnce([{ id: 'b' }] as never);
    eventManager.emit('PartnerRevoke', { sharedById: 'a', sharedWithId: 'me' });
    await vi.waitFor(() => expect(railSession.partners).toHaveLength(1));

    sdkMock.getPartners.mockRejectedValueOnce(new Error('offline'));
    await railSession.refreshPartners();
    expect(railSession.partners).toEqual([]);
  });

  it('reads the full albums only when asked, once until the tree changes', async () => {
    sdkMock.getAlbumRail.mockResolvedValue(rail('Trips') as never);
    sdkMock.getAlbumHierarchy.mockResolvedValue(hierarchy('Trips') as never);
    await railSession.refreshAlbums();
    expect(sdkMock.getAlbumHierarchy).not.toHaveBeenCalled();

    const [first, second] = await Promise.all([railSession.fullAlbums(), railSession.fullAlbums()]);
    expect(first.map(({ albumName }) => albumName)).toEqual(['Trips']);
    expect(second).toBe(first);
    expect(sdkMock.getAlbumHierarchy).toHaveBeenCalledTimes(1);

    // the same answer again keeps what was read
    await railSession.refreshAlbums();
    await railSession.fullAlbums();
    expect(sdkMock.getAlbumHierarchy).toHaveBeenCalledTimes(1);

    sdkMock.getAlbumRail.mockResolvedValue(rail('Trips', 'Hikes') as never);
    await railSession.refreshAlbums();
    await railSession.fullAlbums();
    expect(sdkMock.getAlbumHierarchy).toHaveBeenCalledTimes(2);
  });

  it('keeps the same tree, unredrawn, when the rail list has not changed', async () => {
    sdkMock.getAlbumRail.mockResolvedValue(rail('Trips') as never);
    await railSession.refreshAlbums();
    const first = railSession.albums[''];
    await railSession.refreshAlbums();
    expect(railSession.albums['']).toBe(first);
  });

  it('never hands out full albums read before the access changed', async () => {
    let answer!: (value: never) => void;
    sdkMock.getAlbumHierarchy.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const first = railSession.fullAlbums();
    const second = railSession.fullAlbums();
    eventManager.emit('SessionLocked');
    answer(hierarchy('Locked album') as never);
    // every caller, not only the first
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]);
  });
});
