<script lang="ts">
  /**
   * FL-1838: in the viewer of an album made from a folder, the other versions of the open photo (its RAW, its
   * original, its edits) as a row of thumbnails named by folder. The album shows one of them in front; the rest are
   * reachable here.
   */
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, getAlbumVersions, type AlbumVersionDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  interface Props {
    albumId: string;
    assetId: string;
    onPick: (assetId: string) => void;
  }

  let { albumId, assetId, onPick }: Props = $props();

  let versions = $state<AlbumVersionDto[]>([]);
  /** The group the row shows: stepping between its versions keeps it, so it never flickers away. */
  const inGroup = (id: string) => versions.some((version) => version.id === id);

  $effect(() => {
    const id = assetId;
    if (inGroup(id)) {
      return;
    }
    const current = authManager.captureSession();
    const controller = new AbortController();
    versions = [];
    getAlbumVersions({ id: albumId, assetId: id }, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted && current() && assetId === id) {
          versions = result.versions;
        }
      })
      // a shortcut only: without it the viewer still shows the photo in front
      .catch(() => {});
    return () => controller.abort();
  });
</script>

{#if versions.length > 1}
  <div class="fl-album-versions" role="group" aria-label={$t('frameleaf_album_folders_versions')}>
    <span class="label">{$t('frameleaf_album_folders_versions')}</span>
    {#each versions as version (version.id)}
      <button
        type="button"
        class="version"
        aria-current={version.id === assetId ? 'true' : undefined}
        title={version.originalFileName}
        onclick={() => onPick(version.id)}
      >
        <img src={getAssetMediaUrl({ id: version.id, size: AssetMediaSize.Thumbnail })} alt="" />
        <span>{version.folder || version.originalFileName}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .fl-album-versions {
    position: fixed;
    inset-block-start: 72px;
    inset-inline-start: 50%;
    z-index: 1001;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    color: #fff;
    background: rgb(0 0 0 / 0.7);
    border-radius: var(--fl-radius, 12px);
    transform: translateX(-50%);
  }
  .label {
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .version {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 4px;
    color: inherit;
    background: none;
    border: 2px solid transparent;
    border-radius: 8px;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .version[aria-current='true'] {
    border-color: var(--fl-accent, #22c55e);
  }
  .version img {
    width: 48px;
    height: 48px;
    object-fit: cover;
    border-radius: 4px;
  }
</style>
