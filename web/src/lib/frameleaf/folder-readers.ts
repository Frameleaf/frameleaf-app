/**
 * Where the one folder chooser (`FolderChooser.svelte`, FL-1814) gets its folders: the locations
 * this server may import from, or the folders on the server's own disks.
 */
import {
  browseLibraryFolders,
  getTakeoutFolders,
  type LibraryFolderBrowseResponseDto,
  type TakeoutFolderContentsDto,
  type TakeoutRootDto,
} from '@frameleaf/sdk';
import { mdiHarddisk } from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';
import { formatBytes } from '$lib/frameleaf/format-bytes';

/** A folder in the list, or a step of the trail. `id` is whatever the reader needs to open it. */
export type FolderEntry = { id?: string; name: string; detail?: string; icon?: string };

/** What a reader says about the open folder. */
export type FolderListing<Extra = unknown> = {
  folders: FolderEntry[];
  /** Whether the open folder can be chosen. */
  choosable: boolean;
  /** What the open folder holds, shown beside "Choose this folder". */
  detail?: string;
  /** Where this is, when the server knows better than the steps taken (a start path it resolved). */
  trail?: FolderEntry[];
  /** A line about this folder in place of the standing note ("Only the first 500 folders are shown"). */
  note?: string;
  /** Why the open folder cannot be used ("Frameleaf can’t open this folder"). */
  problem?: string;
  /** The server's own answer, for the caller's `onChoose` and `empty`. */
  extra?: Extra;
};

/** A folder the administrator chose: its location, the folders below it, and what it holds. */
export type ChosenTakeoutFolder = { rootId: string; parts: string[]; contents: TakeoutFolderContentsDto };

/** The folder holds something a Google Photos import can read. */
export const holdsTakeoutExport = ({ zip, tgz, unpacked }: TakeoutFolderContentsDto) => zip + tgz > 0 || unpacked;

/** What a folder holds, in words: "3 .tgz files · 12 GB", "Google Photos folder" or "No Google export found". */
export const describeTakeoutFolder = (contents: TakeoutFolderContentsDto, t: MessageFormatter, locale?: string) => {
  const parts = [];
  if (contents.zip > 0) {
    parts.push(t('frameleaf_takeout_folder_zip_files', { values: { count: contents.zip } }));
  }
  if (contents.tgz > 0) {
    parts.push(t('frameleaf_takeout_folder_tgz_files', { values: { count: contents.tgz } }));
  }
  if (parts.length > 0) {
    return [...parts, formatBytes(contents.bytes, locale)].join(' · ');
  }
  return contents.unpacked ? t('frameleaf_takeout_folder_unpacked') : t('frameleaf_takeout_folder_no_export');
};

/** What `onChoose` gets from the import chooser, as the importers take it. */
export const chosenTakeoutFolder = (
  trail: FolderEntry[],
  listing: FolderListing<TakeoutFolderContentsDto>,
): ChosenTakeoutFolder => ({
  rootId: trail[0].id!,
  parts: trail.slice(1).map((step) => step.name),
  contents: listing.extra!,
});

/**
 * The locations this server may import from (FL-1477): the top level is the built-in Imports
 * folder and any other permitted location, and each folder says what it holds, as the server read it.
 */
export const takeoutFolderReader =
  (
    roots: TakeoutRootDto[],
    t: MessageFormatter,
    {
      detail,
      folderIcon,
      canChoose = () => true,
    }: {
      /** What a folder holds, in words. Google Photos exports by default; another import says its own. */
      detail: (contents: TakeoutFolderContentsDto) => string;
      /** The icon for a folder of this name. */
      folderIcon?: (name: string) => string | undefined;
      /** Whether the open folder (its location, then the folders below it) can be chosen. */
      canChoose?: (root: TakeoutRootDto, parts: string[]) => boolean;
    },
  ) =>
  async (trail: FolderEntry[]): Promise<FolderListing<TakeoutFolderContentsDto>> => {
    const root = roots.find((item) => item.id === trail[0]?.id);
    if (!root) {
      return {
        choosable: false,
        folders: roots.map((item) => ({
          id: item.id,
          // The built-in Imports folder goes by its name; an operator's folder by its path.
          name: item.builtIn ? t('frameleaf_takeout_imports_name') : item.path,
          detail: item.builtIn ? t('frameleaf_takeout_imports_built_in') : undefined,
          icon: mdiHarddisk,
        })),
      };
    }
    const parts = trail.slice(1).map((step) => step.name);
    const result = await getTakeoutFolders({ rootId: root.id, path: parts.join('/') });
    return {
      folders: result.folders.map((folder) => ({
        name: folder.name,
        detail: detail(folder),
        icon: folderIcon?.(folder.name),
      })),
      choosable: canChoose(root, parts),
      detail: detail(result.here),
      extra: result.here,
    };
  };

/** A path on the server as the chooser's steps: `/mnt/photos` is "mnt", then "photos". */
export const pathTrail = (path?: string): FolderEntry[] => {
  const names = (path ?? '').split('/').filter(Boolean);
  return names.map((name, index) => ({ id: `/${names.slice(0, index + 1).join('/')}`, name }));
};

/** The folders on the server's own disks (`browseLibraryFolders`, names only). The top cannot be chosen. */
export const libraryFolderReader =
  (t: MessageFormatter) =>
  async (trail: FolderEntry[]): Promise<FolderListing<LibraryFolderBrowseResponseDto>> => {
    const result = await browseLibraryFolders({ path: trail.at(-1)?.id });
    return {
      trail: pathTrail(result.path),
      folders: result.folders.map(({ name, path }) => ({ id: path, name })),
      choosable: result.path !== '/' && result.readable,
      detail: result.path,
      note: result.truncated ? t('frameleaf_libraries_browse_truncated') : undefined,
      problem: result.readable ? undefined : t('frameleaf_libraries_browse_unreadable'),
      extra: result,
    };
  };
