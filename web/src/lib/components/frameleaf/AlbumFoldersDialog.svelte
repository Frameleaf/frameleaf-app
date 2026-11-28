<script lang="ts">
  /**
   * FL-1838 "Folders in this album" (prototype `AlbumPageV2.jsx` `FoldersDialog`, approved 2026-11-27): per folder,
   * with the others, in a section of its own, as an album inside, or hidden; the same photo found in more than one
   * folder shown once (the preferred version in front, in the "Show in front" order) or every time; and "Use these for
   * every album from <library>".
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AlbumFolderDisplay,
    AlbumFolderVersions,
    updateAlbumFolders,
    type AlbumFoldersResponseDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiCameraIris,
    mdiChevronDown,
    mdiChevronUp,
    mdiFolderOutline,
    mdiImageEditOutline,
    mdiImageOutline,
    mdiVideoOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    albumId: string;
    folders: AlbumFoldersResponseDto;
    open?: boolean;
    onSaved: (folders: AlbumFoldersResponseDto) => void;
  }

  let { albumId, folders, open = $bindable(false), onSaved }: Props = $props();

  const groupId = $props.id();
  let display = $state<Record<string, AlbumFolderDisplay>>({});
  let versions = $state<AlbumFolderVersions>(AlbumFolderVersions.One);
  let prefer = $state<string[]>([]);
  let applyToLibrary = $state(false);
  let saving = $state(false);

  /** The show-in-front list: the saved order, then any folder it leaves out, so each folder can be placed. */
  const preferOrder = (saved: string[]) => {
    const names = folders.folders.map(({ name }) => name);
    const known = saved.filter((name) => names.some((each) => each.toLowerCase() === name.toLowerCase()));
    return [...known, ...names.filter((name) => known.every((each) => each.toLowerCase() !== name.toLowerCase()))];
  };

  $effect(() => {
    if (!open) {
      return;
    }
    display = Object.fromEntries(folders.folders.map(({ name, display }) => [name, display]));
    versions = folders.versions;
    prefer = preferOrder(folders.prefer);
    applyToLibrary = false;
  });

  const folderName = $derived(folders.folderPath?.split('/').findLast(Boolean) ?? '');
  const libraryName = $derived(folders.libraryName ?? '');
  const matched = $derived(folders.matchedByName + folders.matchedByTime);

  const iconFor = (name: string, videos: number) => {
    const lower = name.toLowerCase();
    if (videos > 0 || lower.startsWith('video')) {
      return mdiVideoOutline;
    }
    if (lower === 'raw') {
      return mdiCameraIris;
    }
    if (lower.startsWith('edit') || lower.startsWith('export')) {
      return mdiImageEditOutline;
    }
    return lower === 'original' ? mdiImageOutline : mdiFolderOutline;
  };

  const showOptions = $derived([
    { value: AlbumFolderDisplay.With, label: $t('frameleaf_album_folders_with') },
    { value: AlbumFolderDisplay.Section, label: $t('frameleaf_album_folders_section') },
    { value: AlbumFolderDisplay.Album, label: $t('frameleaf_album_folders_album') },
    { value: AlbumFolderDisplay.Hidden, label: $t('frameleaf_album_folders_hidden_option') },
  ]);

  const versionChoices = $derived([
    {
      id: AlbumFolderVersions.One,
      label: $t('frameleaf_album_folders_once'),
      body: $t('frameleaf_album_folders_once_body'),
    },
    {
      id: AlbumFolderVersions.Each,
      label: $t('frameleaf_album_folders_each'),
      body: $t('frameleaf_album_folders_each_body'),
    },
  ]);

  /** Only folders shown with the others or hidden have versions to put in front; the rest keep their place. */
  const ranked = $derived(
    prefer.filter((name) => display[name] === AlbumFolderDisplay.With || display[name] === AlbumFolderDisplay.Hidden),
  );
  /** Swaps a ranked folder with the ranked one above or below it, leaving the others where they are. */
  const move = (index: number, by: number) => {
    const next = [...prefer];
    const from = next.indexOf(ranked[index]);
    const to = next.indexOf(ranked[index + by]);
    next[from] = ranked[index + by];
    next[to] = ranked[index];
    prefer = next;
  };

  const save = async () => {
    saving = true;
    try {
      const saved = await updateAlbumFolders({
        id: albumId,
        albumFoldersUpdateDto: { folders: display, versions, prefer, applyToLibrary },
      });
      onSaved(saved);
      toastManager.primary(
        applyToLibrary
          ? $t('frameleaf_album_folders_saved_all', { values: { library: libraryName } })
          : $t('frameleaf_album_folders_saved'),
      );
      open = false;
    } catch (error) {
      handleError(error, $t('frameleaf_album_folders_save_error'));
    } finally {
      saving = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_album_folders_title')} closeLabel={$t('close')} size="wide" bind:open>
  <div class="fl-album-folders-dialog">
    <p class="lead">
      {$t('frameleaf_album_folders_lead', { values: { folder: folderName } })}
    </p>

    <ul class="rows">
      {#each folders.folders as folder (folder.name)}
        <li>
          <Icon icon={iconFor(folder.name, folder.videos)} size="20" />
          <span class="row-name">
            <strong>{folder.name}</strong>
            <small>
              {folder.videos > 0 && folder.photos === 0
                ? $t('frameleaf_album_folders_videos', { values: { count: folder.videos } })
                : $t('frameleaf_album_folders_items', { values: { count: folder.photos + folder.videos } })}
            </small>
          </span>
          <SegmentedControl
            label={$t('frameleaf_album_folders_show_folder', { values: { folder: folder.name } })}
            options={showOptions}
            value={display[folder.name]}
            onChange={(value) => (display = { ...display, [folder.name]: value as AlbumFolderDisplay })}
          />
        </li>
      {/each}
    </ul>

    <h3>{$t('frameleaf_album_folders_versions_title')}</h3>
    <p class="note">
      {matched > 0
        ? $t('frameleaf_album_folders_matched', {
            values: { count: matched, byName: folders.matchedByName, byTime: folders.matchedByTime },
          })
        : $t('frameleaf_album_folders_matched_none')}
    </p>
    <div class="choices" role="radiogroup" aria-label={$t('frameleaf_album_folders_versions_title')}>
      {#each versionChoices as choice (choice.id)}
        <label class="choice" class:is-on={versions === choice.id}>
          <input type="radio" name={`${groupId}-versions`} value={choice.id} bind:group={versions} />
          <span>
            <strong>{choice.label}</strong>
            <small>{choice.body}</small>
          </span>
        </label>
      {/each}
    </div>

    {#if versions === AlbumFolderVersions.One}
      <div class="prefer">
        <span class="prefer-label" id={`${groupId}-front`}>{$t('frameleaf_album_folders_front')}</span>
        <ol aria-labelledby={`${groupId}-front`}>
          {#each ranked as name, index (name)}
            <li>
              <span class="rank">{index + 1}</span>
              <span class="prefer-name">{name}</span>
              {#if display[name] === AlbumFolderDisplay.Hidden}
                <small>{$t('frameleaf_album_folders_front_hidden')}</small>
              {/if}
              <span class="prefer-move">
                <button
                  type="button"
                  class="fl-control"
                  aria-label={$t('frameleaf_album_folders_move_up', { values: { folder: name } })}
                  disabled={index === 0}
                  onclick={() => move(index, -1)}
                >
                  <Icon icon={mdiChevronUp} size="18" />
                </button>
                <button
                  type="button"
                  class="fl-control"
                  aria-label={$t('frameleaf_album_folders_move_down', { values: { folder: name } })}
                  disabled={index === ranked.length - 1}
                  onclick={() => move(index, 1)}
                >
                  <Icon icon={mdiChevronDown} size="18" />
                </button>
              </span>
            </li>
          {/each}
        </ol>
      </div>
    {/if}

    {#if libraryName}
      <label class="apply">
        <input type="checkbox" bind:checked={applyToLibrary} />
        <span>
          <strong>{$t('frameleaf_album_folders_apply', { values: { library: libraryName } })}</strong>
          <small>{$t('frameleaf_album_folders_apply_body')}</small>
        </span>
      </label>
    {/if}
  </div>

  {#snippet actions()}
    <Button disabled={saving} onclick={() => (open = false)}>{$t('cancel')}</Button>
    <Button variant="primary" initialFocus disabled={saving} onclick={() => void save()}>{$t('save')}</Button>
  {/snippet}
</Dialog>

<style>
  /* albums-v2.css `.ap2-dialog`: 12px between stacked rows, 24px between sections, 8px between controls. */
  .fl-album-folders-dialog {
    display: flex;
    flex-direction: column;
    gap: 12px;
    color: var(--fl-text);
  }
  .lead,
  .note {
    margin: 0;
  }
  .note,
  small {
    color: var(--fl-muted);
  }
  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  .rows li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
  }
  .rows li + li {
    border-block-start: 1px solid var(--fl-border);
  }
  .row-name {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  h3 {
    margin: 12px 0 0;
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: 8px;
  }
  .choice {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    cursor: pointer;
  }
  .choice.is-on {
    border-color: var(--fl-accent);
  }
  .choice span,
  .apply span {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .prefer {
    display: flex;
    align-items: flex-start;
    gap: 16px;
  }
  .prefer-label {
    padding-block-start: 8px;
    font-size: var(--fl-font-small);
    font-weight: 600;
    white-space: nowrap;
  }
  .prefer ol {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .prefer li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 8px 4px 12px;
    background: var(--fl-raised);
    border-radius: var(--fl-radius);
  }
  .rank {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    font-size: var(--fl-font-small);
    background: var(--fl-border);
    border-radius: 999px;
  }
  .prefer-move {
    display: flex;
    gap: 8px;
    margin-inline-start: auto;
  }
  .prefer-move button {
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: 32px;
    color: var(--fl-text);
    background: none;
    border: 0;
    border-radius: var(--fl-radius-control);
  }
  .prefer-move button:disabled {
    opacity: 0.35;
  }
  .apply {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-block-start: 12px;
    padding-block-start: 24px;
    border-block-start: 1px solid var(--fl-border);
  }
  @media (max-width: 700px) {
    .rows li {
      flex-wrap: wrap;
    }
    .prefer {
      flex-direction: column;
      gap: 8px;
    }
  }
</style>
