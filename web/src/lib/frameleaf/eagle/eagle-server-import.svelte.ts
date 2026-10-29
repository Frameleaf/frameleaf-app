import {
  EagleImportStatus,
  EagleImportTargetMode,
  checkEagleLibrary,
  createEagleImport,
  getEagleImport,
  getEagleImports,
  getEagleLibraries,
  stopEagleImport,
  type EagleImportResponseDto,
  type EagleLibraryResponseDto,
} from '@frameleaf/sdk';
import { SvelteSet } from 'svelte/reactivity';
import type { EagleFolder, EagleItemOutcome, EagleLibrary, EagleTarget } from '$lib/frameleaf/eagle/eagle-import';
import type { EagleRecentItem } from '$lib/frameleaf/eagle/eagle-import-run.svelte';
import type { EagleRunStatus } from '$lib/frameleaf/eagle/eagle-import-status.svelte';

/**
 * "In a folder your server can open" (FL-653, README points 36 and 39). The server lists the
 * `.library` folders in the import folders an administrator allowed, reads the chosen one for the
 * check, and imports it itself, so the import keeps going with the tab or the browser closed. This
 * tab only shows how far it has got, from the server's record.
 */

/** Where a library is on the server: an allowed import folder and the path below it. */
export interface EagleServerLocation {
  rootId: string;
  path: string;
}

/** The server's read of a library, as the check and the report use it. */
export function libraryFromServer(dto: EagleLibraryResponseDto): EagleLibrary {
  const byId = new Map<string, EagleFolder>();
  const top: EagleFolder[] = [];
  // Parents come before their children, so each child's parent is already there.
  for (const { id, name, parentId, description, color, icon } of dto.folders) {
    const folder: EagleFolder = {
      id,
      name,
      ...(description && { description }),
      ...(color && { color }),
      ...(icon && { icon }),
      children: [],
    };
    byId.set(id, folder);
    const parent = parentId ? byId.get(parentId) : undefined;
    (parent ? parent.children : top).push(folder);
  }
  return {
    name: dto.name,
    folders: top,
    smartFolders: dto.smartFolders,
    tagGroups: dto.tagGroups,
    ...(dto.changed && { changed: dto.changed }),
    items: dto.items.map(({ unreadable, ...item }) => ({ ...item, ...(unreadable && { unreadable }) })),
    fingerprint: dto.fingerprint,
  };
}

export const listServerLibraries = () => getEagleLibraries();

export async function readServerLibrary(location: EagleServerLocation, signal?: AbortSignal) {
  const dto = await checkEagleLibrary({ eagleLibraryCheckDto: location }, { signal });
  return { library: libraryFromServer(dto), supported: new Set(dto.supported) };
}

/** What earlier runs of a server import did, keyed by Eagle id, to carry it on. */
export async function serverOutcomes(id: string): Promise<Record<string, EagleItemOutcome>> {
  return (await getEagleImport({ id, outcomes: true })).outcomes ?? {};
}

/** The server's unfinished import of this library, if there is one. */
export async function findServerImport(location: EagleServerLocation, fingerprint: string) {
  const { imports } = await getEagleImports();
  return imports.find(
    (item) => item.rootId === location.rootId && item.path === location.path && item.fingerprint === fingerprint,
  );
}

/** The import the server is running for you now, if any, so Boards can show how far it has got. */
export async function runningServerImport() {
  const { imports } = await getEagleImports();
  const live = imports.find(
    ({ status }) => status === EagleImportStatus.Running || status === EagleImportStatus.Stopping,
  );
  return live && new ServerEagleImportRun(live);
}

const POLL_MS = 2000;

/** An import the server is running, followed from this tab. Implements what the dialog and the rail show. */
export class ServerEagleImportRun implements EagleRunStatus {
  state = $state<EagleRunStatus['state']>('running');
  done = $state(0);
  /** Of those, how many were already in the library. */
  already = $state(0);
  total = $state(0);
  outcomes = $state<Record<string, EagleItemOutcome>>({});
  readonly failed = new SvelteSet<string>();
  recent = $state<EagleRecentItem[]>([]);
  collections = $state(0);
  error = $state<unknown>();
  readonly id: string;
  readonly location: EagleServerLocation;
  readonly fingerprint: string;
  rootAlbumId = $state<string | undefined>();
  target: EagleTarget;
  #finished: Promise<void> | undefined;

  constructor(dto: EagleImportResponseDto) {
    this.id = dto.id;
    this.location = { rootId: dto.rootId, path: dto.path };
    this.fingerprint = dto.fingerprint;
    this.target =
      dto.targetMode === EagleImportTargetMode.Top
        ? { mode: 'top' }
        : { mode: 'inside', inside: dto.insideAlbumId ?? 'new' };
    this.#apply(dto);
  }

  /** Starts it on the server, or carries on its earlier run there. */
  static async begin(
    location: EagleServerLocation,
    library: Pick<EagleLibrary, 'fingerprint'>,
    target: EagleTarget,
    existingTop: string[],
  ) {
    const dto = await createEagleImport({
      eagleImportCreateDto: {
        ...location,
        fingerprint: library.fingerprint,
        targetMode: target.mode === 'top' ? EagleImportTargetMode.Top : EagleImportTargetMode.Inside,
        ...(target.mode === 'inside' && target.inside !== 'new' && { insideAlbumId: target.inside }),
        existingTop,
      },
    });
    return new ServerEagleImportRun(dto);
  }

  /** Follows the import until it has finished or stopped; then reads what became of every item. */
  start(): Promise<void> {
    this.#finished ??= this.#follow();
    return this.#finished;
  }

  /** Stops after the item the server is bringing over now; everything already brought over stays. */
  stop() {
    if (this.state !== 'running') {
      return;
    }
    this.state = 'stopping';
    void stopEagleImport({ id: this.id })
      .then((dto) => this.#apply(dto))
      .catch((error: unknown) => {
        this.error = error;
      });
  }

  async #follow() {
    let misses = 0;
    while (this.state === 'running' || this.state === 'stopping') {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      try {
        const ended = await this.#refresh(false);
        misses = 0;
        if (ended) {
          break;
        }
      } catch (error) {
        // The server is restarting or the network blinked: the import carries on there regardless.
        if (++misses >= 30) {
          this.error = error;
          return;
        }
      }
    }
    await this.#refresh(true).catch((error: unknown) => {
      this.error = error;
    });
  }

  async #refresh(withOutcomes: boolean) {
    const dto = await getEagleImport({ id: this.id, ...(withOutcomes && { outcomes: true }) });
    this.#apply(dto);
    return dto.status === EagleImportStatus.Stopped || dto.status === EagleImportStatus.Finished;
  }

  #apply(dto: EagleImportResponseDto) {
    this.state = dto.status;
    this.done = dto.done;
    this.already = dto.already;
    this.total = dto.total;
    this.collections = dto.collections;
    this.recent = dto.recent;
    this.rootAlbumId = dto.rootAlbumId ?? undefined;
    if (dto.outcomes) {
      this.outcomes = dto.outcomes;
    }
    this.failed.clear();
    for (const id of dto.failed) {
      this.failed.add(id);
    }
    if (dto.error) {
      this.error = new Error(dto.error);
    }
  }
}
