<script lang="ts" module>
  import type { AlbumResponseDto, PersonResponseDto } from '@immich/sdk';

  export type ViewerChooserPick =
    { kind: 'album'; album: AlbumResponseDto } | { kind: 'person'; person: PersonResponseDto };
</script>

<script lang="ts">
  /**
   * The viewer's "Set as" chooser (audit V-9), ported from `ChooserDialog` in
   * `design/frameleaf/template/src/MediaViewer.jsx:2242-2292` and `.mv-choice-list`
   * (media-viewer.css:1818-1897): a list of the albums that hold the item, for its cover, or of the
   * people tagged in it, for their featured photo. The caller passes only what the user may change;
   * picking resolves with the choice and the caller runs the existing action for it.
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight, mdiImageAlbum } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    kind: 'album' | 'person';
    albums?: AlbumResponseDto[];
    people?: PersonResponseDto[];
    onClose: (pick?: ViewerChooserPick) => void;
  }

  const { kind, albums = [], people = [], onClose }: Props = $props();

  let open = $state(true);
  let picked: ViewerChooserPick | undefined;

  $effect(() => {
    if (!open) {
      onClose(picked);
    }
  });

  const pick = (choice: ViewerChooserPick) => {
    picked = choice;
    open = false;
  };

  const empty = $derived(kind === 'album' ? albums.length === 0 : people.length === 0);
</script>

<Dialog
  bind:open
  title={kind === 'album' ? $t('frameleaf_viewer_chooser_album_title') : $t('frameleaf_viewer_chooser_person_title')}
  closeLabel={$t('close')}
>
  {#if empty}
    <p class="mv-dialog-copy">
      {kind === 'album' ? $t('frameleaf_viewer_chooser_no_albums') : $t('frameleaf_viewer_chooser_no_people')}
    </p>
  {:else}
    <div class="mv-choice-list" data-testid="viewer-chooser">
      {#if kind === 'album'}
        {#each albums as album, index (album.id)}
          <button
            type="button"
            class="fl-continuous-corners"
            data-initial-focus={index === 0 ? '' : undefined}
            onclick={() => pick({ kind: 'album', album })}
          >
            {#if album.albumThumbnailAssetId}
              <img
                class="fl-continuous-corners"
                src={getAssetMediaUrl({ id: album.albumThumbnailAssetId, size: AssetMediaSize.Thumbnail })}
                alt=""
              />
            {:else}
              <Icon icon={mdiImageAlbum} size="20" aria-hidden />
            {/if}
            <span>{album.albumName}</span>
            <Icon icon={mdiChevronRight} size="18" aria-hidden />
          </button>
        {/each}
      {:else}
        {#each people as person, index (person.id)}
          <button
            type="button"
            class="fl-continuous-corners"
            data-initial-focus={index === 0 ? '' : undefined}
            onclick={() => pick({ kind: 'person', person })}
          >
            <PersonAvatar {person} size={36} />
            <span>{person.name}</span>
            <Icon icon={mdiChevronRight} size="18" aria-hidden />
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</Dialog>

<style>
  .mv-dialog-copy {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-size);
    line-height: 1.5;
  }

  .mv-choice-list {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
  }

  .mv-choice-list button {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 48px;
    padding: 6px 10px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: transparent;
    color: var(--fl-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .mv-choice-list button:hover {
    background: var(--fl-raised);
  }

  .mv-choice-list button > span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mv-choice-list img {
    width: 36px;
    height: 36px;
    border-radius: var(--fl-radius-control);
    object-fit: cover;
  }

  .mv-choice-list button > :global(svg:last-child) {
    color: var(--fl-muted);
  }

  @supports (corner-shape: squircle) {
    .mv-choice-list button {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }

    .mv-choice-list img {
      border-radius: calc(var(--fl-radius-control) * 1.8);
    }
  }
</style>
