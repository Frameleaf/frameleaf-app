/**
 * FL-1448 Creators in Boards: the creators this account follows or added, shared by the Boards rail
 * and the Creators page so both show the same names and counts.
 */
import {
  createMediaSubscription,
  getAllAlbums,
  getMediaCapabilities,
  getMediaConnections,
  getMediaCreator,
  getMediaCreators,
  isHttpError,
  LibraryViewScope,
  MediaConnectionStatus,
  MediaImportState,
  MediaInspectionKind,
  previewMediaSubscription,
  type AlbumResponseDto,
  type MediaCapabilitiesDto,
  type MediaConnectionResponseDto,
  type MediaCreatorItemResponse,
  type MediaCreatorResponseDto,
  type MediaImportResponseDto,
  type MediaSubscriptionCreateDto,
} from '@frameleaf/sdk';
import {
  mediaImportActive,
  mediaReceiptKey,
  pollMediaImport,
  privateMediaParents,
} from '$lib/components/frameleaf/media/boards-media';
import { authManager } from '$lib/managers/auth-manager.svelte';

export type CreatorsStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'failed';

const isMissing = (error: unknown) => isHttpError(error) && error.status === 404;

class CreatorsStore {
  creators = $state<MediaCreatorResponseDto[]>([]);
  status = $state<CreatorsStatus>('idle');
  /** Why this Library cannot save from the web, when it says. */
  reason = $state<string | null>(null);
  capabilities = $state<MediaCapabilitiesDto>();
  connections = $state<MediaConnectionResponseDto[]>([]);
  /** Every Boards collection, for the names of the folders creators are filed under. */
  albums = $state<AlbumResponseDto[]>([]);
  /** The Connected sites sheet, opened from the rail's foot and from a sign-in notice. */
  connectionsOpen = $state(false);
  /** "Add from the web…" asks Home to put the cursor in its box. */
  focusAdd = $state(0);
  /** The Downloads tray, opened when something starts. */
  trayOpen = $state(false);
  /** Bumped when downloads should be read again. */
  downloads = $state(0);
  /** An item opened from Home, shown in Details before its creator's page has loaded it. */
  opened = $state<MediaCreatorItemResponse | null>(null);

  #request = 0;
  #owner = '';
  #account = () => (authManager.authenticated ? authManager.user.id : '');
  #loading: Promise<void> | undefined;

  get newCount() {
    return this.creators.reduce((total, creator) => total + creator.newCount, 0);
  }

  get following() {
    return this.creators.filter((creator) => creator.following);
  }

  get connected() {
    return this.connections.filter(({ status }) => status === MediaConnectionStatus.Connected);
  }

  /** Private collections a creator can be filed under; never a creator's own collection. */
  get folders() {
    const own = new Set(this.creators.map(({ albumId }) => albumId));
    const ownerId = authManager.authenticated ? authManager.user.id : '';
    return privateMediaParents(this.albums, ownerId).filter(({ id }) => !own.has(id));
  }

  folderName(id: string | null) {
    return id ? this.albums.find((album) => album.id === id)?.albumName : undefined;
  }

  /** Loads once; a second caller (the rail and the page mount together) waits for the same answer. */
  ensure() {
    // Another account signed in since: nothing of the last one's is shown.
    if (this.status !== 'idle' && this.#owner !== this.#account()) {
      this.reset();
    }
    if (this.status === 'idle') {
      return this.load();
    }
    return this.#loading ?? Promise.resolve();
  }

  load() {
    this.#loading = this.#load();
    return this.#loading;
  }

  async #load() {
    const version = ++this.#request;
    const current = authManager.captureSession();
    const fresh = () => version === this.#request && current();
    this.#owner = this.#account();
    this.status = 'loading';
    this.reason = null;
    try {
      const capabilities = await getMediaCapabilities();
      if (!fresh()) {
        return;
      }
      this.capabilities = capabilities;
      if (!capabilities.available) {
        this.reason = capabilities.reason;
        this.status = 'unavailable';
        return;
      }
      const { creators } = await getMediaCreators();
      if (!fresh()) {
        return;
      }
      this.creators = creators;
      this.status = 'ready';
    } catch (error) {
      if (fresh()) {
        // An older Library has no Creators: Items keeps working and this area says so.
        this.status = isMissing(error) ? 'unavailable' : 'failed';
      }
      return;
    }
    await Promise.all([this.loadConnections(), this.loadFolders()]);
  }

  /** The creators again, after something was followed, saved or seen. Keeps what is shown on failure. */
  async refresh() {
    if (this.status !== 'ready') {
      return;
    }
    const version = this.#request;
    const current = authManager.captureSession();
    try {
      const { creators } = await getMediaCreators();
      if (version === this.#request && current()) {
        this.creators = creators;
      }
    } catch {
      // The list on show stays; the next change reads it again.
    }
  }

  async refreshCreator(id: string) {
    const current = authManager.captureSession();
    try {
      const creator = await getMediaCreator({ id });
      if (current()) {
        this.replace(creator);
      }
    } catch {
      // As above.
    }
  }

  replace(creator: MediaCreatorResponseDto) {
    this.creators = this.creators.some(({ id }) => id === creator.id)
      ? this.creators.map((value) => (value.id === creator.id ? creator : value))
      : [...this.creators, creator];
  }

  async loadConnections() {
    const current = authManager.captureSession();
    try {
      const { connections } = await getMediaConnections();
      if (current()) {
        this.connections = connections;
      }
    } catch {
      // Without the list a sign-in notice still offers Connect.
    }
  }

  async loadFolders() {
    const current = authManager.captureSession();
    try {
      const albums = await getAllAlbums({ libraryScope: LibraryViewScope.Design });
      if (current()) {
        this.albums = albums;
      }
    } catch {
      // Without folders a creator is simply not filed under one.
    }
  }

  /** A connected site whose approved domains cover this address. */
  connectionFor(address: string | null | undefined) {
    let hostname = '';
    try {
      hostname = new URL(address ?? '').hostname;
    } catch {
      return;
    }
    return this.connected.find(({ domains }) =>
      domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)),
    );
  }

  started() {
    this.trayOpen = true;
    this.downloads++;
  }

  reset() {
    this.#request++;
    this.#loading = undefined;
    this.creators = [];
    this.status = 'idle';
    this.reason = null;
    this.capabilities = undefined;
    this.connections = [];
    this.albums = [];
    this.connectionsOpen = false;
    this.trayOpen = false;
    this.opened = null;
  }
}

export const creatorsStore = new CreatorsStore();

/** Waits, with the Library's own poll, until an inspection has stopped reading its address. */
export const awaitMediaInspection = (first: MediaImportResponseDto, signal: AbortSignal) => {
  if (!mediaImportActive(first.state)) {
    return Promise.resolve(first);
  }
  return new Promise<MediaImportResponseDto>((resolve, reject) => {
    const stop = pollMediaImport(
      first.id,
      (value) => {
        if (!mediaImportActive(value.state)) {
          resolve(value);
        }
      },
      () => {},
    );
    signal.addEventListener(
      'abort',
      () => {
        stop();
        reject(new DOMException('Stopped', 'AbortError'));
      },
      { once: true },
    );
  });
};

/** A whole channel or account the Library can follow. */
export const isFollowable = (preview: MediaImportResponseDto | undefined) =>
  preview?.state === MediaImportState.Ready && preview.kind === MediaInspectionKind.Feed && !!preview.creatorId;

export type FollowOptions = Omit<MediaSubscriptionCreateDto, 'idempotencyKey' | 'inspectionId'>;

/** Follows what a finished preview found. The receipt key stays the same while the choices do. */
export const followPreview = (
  preview: MediaImportResponseDto,
  options: FollowOptions,
  receipts: Map<string, string>,
) => {
  const draft = { inspectionId: preview.id, ...options };
  return createMediaSubscription({
    mediaSubscriptionCreateDto: { ...draft, idempotencyKey: mediaReceiptKey(receipts, draft) },
  });
};

/**
 * Follows a creator already under Creators (added by saving one post) from their own address.
 * `previews` keeps the finished preview of an address, so trying again sends the same request.
 */
export const followAddress = async (
  address: string,
  options: FollowOptions,
  receipts: Map<string, string>,
  previews: Map<string, MediaImportResponseDto>,
  signal: AbortSignal,
) => {
  let preview = previews.get(address);
  if (!preview) {
    const connectionId = creatorsStore.connectionFor(address)?.id;
    const first = await previewMediaSubscription({ mediaInspectDto: { urls: [address], connectionId } }, { signal });
    preview = await awaitMediaInspection(first, signal);
    if (!isFollowable(preview)) {
      throw new Error('This address cannot be followed');
    }
    previews.set(address, preview);
  }
  return followPreview(preview, options, receipts);
};
