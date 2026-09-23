<script lang="ts">
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { canContribute, linkableAlbums } from '$lib/frameleaf/shared-space';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    linkSharedSpaceAlbum,
    unlinkSharedSpaceAlbum,
    type AlbumResponseDto,
    type SharedSpaceAlbumResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiLinkVariant, mdiLinkVariantOff } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The albums members have linked into this shared space (FL-55).
   *
   * **A link is a reference, not a move and not a share.** FL-52 nests an album
   * by moving it under a collection; a space deliberately does not do that,
   * because moving somebody's album into a space would take it out of their own
   * library structure — and FL-55's acceptance says revoking a share must not
   * move personal album placement. So the album stays exactly where its owner
   * put it, keeps its own members and its own access rules, and this panel is a
   * list of pointers to it.
   *
   * That is also why a row is not a link to the album's page. Offering one
   * would be a control that works for the album's own members and 403s for
   * everybody else in the space. What the space can honestly say is how much of
   * that album is *here*: the count and the picture come from items that are in
   * both the album and the space, so they are things every member can already
   * see, with anything marked sensitive and anything Locked left out.
   *
   * Unlinking removes the reference. No photo, no album and no membership
   * changes — which is exactly what makes it safe to offer.
   *
   * The picture is the one thing on a row that opens: it is an item already in
   * the space, so it opens in the space's own viewer, where every member may
   * look at it.
   */
  interface Props {
    space: AlbumResponseDto;
    /** The linked albums as the server reports them. */
    albums: SharedSpaceAlbumResponseDto[];
    /** Albums the signed-in person can read, offered to link. */
    library?: AlbumResponseDto[];
    /** Re-fetch after a change; the route owns the loader. */
    onChanged: () => Promise<void> | void;
    /** Open an item that is in the space, in the space's viewer. */
    onOpenAsset?: (assetId: string) => void;
  }

  let { space, albums, library = [], onChanged, onOpenAsset }: Props = $props();

  const currentUserId = $derived(authManager.user.id);
  const contributor = $derived(canContribute(space, currentUserId));
  const options = $derived(
    linkableAlbums(
      library,
      space.id,
      albums.map(({ id }) => id),
    ),
  );

  let choice = $state('');
  let busy = $state(false);
  let status = $state('');

  const link = async () => {
    if (!choice) {
      return;
    }
    busy = true;
    try {
      const picked = options.find(({ id }) => id === choice);
      await linkSharedSpaceAlbum({ id: space.id, albumId: choice });
      status = $t('frameleaf_spaces_album_linked', { values: { name: picked?.albumName ?? '' } });
      choice = '';
      await onChanged();
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_albums'));
    } finally {
      busy = false;
    }
  };

  const unlink = async (album: SharedSpaceAlbumResponseDto) => {
    busy = true;
    try {
      await unlinkSharedSpaceAlbum({ id: space.id, albumId: album.id });
      status = $t('frameleaf_spaces_album_unlinked', { values: { name: album.albumName } });
      await onChanged();
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_albums'));
    } finally {
      busy = false;
    }
  };

  const coverOf = (album: SharedSpaceAlbumResponseDto) =>
    album.thumbnailAssetId ? getAssetMediaUrl({ id: album.thumbnailAssetId, size: AssetMediaSize.Thumbnail }) : null;
</script>

<section class="linked-albums" aria-labelledby="frameleaf-space-albums">
  <h2 id="frameleaf-space-albums">{$t('frameleaf_spaces_albums')}</h2>
  <p class="hint">{$t('frameleaf_spaces_albums_hint')}</p>

  {#if contributor && options.length > 0}
    <div class="controls">
      <label>
        <span>{$t('frameleaf_spaces_album_link')}</span>
        <select bind:value={choice} disabled={busy}>
          <option value="">{$t('frameleaf_spaces_album_link_choose')}</option>
          {#each options as album (album.id)}
            <option value={album.id}>{album.albumName}</option>
          {/each}
        </select>
      </label>
      <button type="button" class="primary" disabled={busy || !choice} onclick={link}>
        <Icon icon={mdiLinkVariant} size="16" aria-hidden={true} />
        {$t('frameleaf_spaces_album_link')}
      </button>
    </div>
  {/if}

  {#if albums.length === 0}
    <p class="empty">{$t('frameleaf_spaces_albums_empty')}</p>
  {:else}
    <ul>
      {#each albums as album (album.id)}
        <li>
          {#if onOpenAsset && album.thumbnailAssetId}
            {@const assetId = album.thumbnailAssetId}
            <button
              type="button"
              class="cover open"
              aria-label={$t('frameleaf_spaces_viewer_open_photo', { values: { name: album.albumName } })}
              title={$t('frameleaf_spaces_viewer_open_photo', { values: { name: album.albumName } })}
              onclick={() => onOpenAsset?.(assetId)}
            >
              <img src={coverOf(album)} alt="" loading="lazy" draggable="false" />
            </button>
          {:else}
            <span class="cover" aria-hidden={true}>
              {#if coverOf(album)}
                <img src={coverOf(album)} alt="" loading="lazy" draggable="false" />
              {:else}
                <AlbumIcon name={album.icon} size="20" />
              {/if}
            </span>
          {/if}
          <span class="about">
            <span class="name">{album.albumName}</span>
            <span class="meta">
              {album.assetCount === 0
                ? $t('frameleaf_spaces_album_none_here')
                : $t('frameleaf_spaces_album_here', { values: { count: album.assetCount } })}
              {#if album.linkedBy}
                · {$t('frameleaf_spaces_album_linked_by', { values: { name: album.linkedBy.name } })}
              {/if}
            </span>
          </span>
          {#if album.canUnlink}
            <button
              type="button"
              class="unlink"
              disabled={busy}
              aria-label={$t('frameleaf_spaces_album_unlink_for', { values: { name: album.albumName } })}
              onclick={() => unlink(album)}
            >
              <Icon icon={mdiLinkVariantOff} size="16" aria-hidden={true} />
              {$t('frameleaf_spaces_album_unlink')}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <Status message={status} {busy} />
</section>

<style>
  .linked-albums {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    color: var(--fl-text);
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
  }
  .hint,
  .empty {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.5rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  select {
    min-height: 36px;
    min-width: 12rem;
    padding: 0 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.375rem 0;
    border-bottom: 1px solid var(--fl-border);
  }
  .cover {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    flex: none;
    overflow: hidden;
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
  }
  button.cover {
    padding: 0;
    min-height: 0;
    border: 1px solid var(--fl-border);
    cursor: pointer;
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .about {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .name {
    font-size: 0.875rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.75rem;
    min-height: 32px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.75rem;
    font-weight: 600;
  }
  button.primary {
    border-color: var(--fl-accent);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  button:disabled {
    opacity: 0.6;
  }
</style>
