<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { isUnnamedPerson } from '$lib/frameleaf/people';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    AssetTypeEnum,
    AssetVisibility,
    searchAssets,
    updatePerson,
    type AssetResponseDto,
    type PersonResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCheck, mdiPlay } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * "Select featured photo" (FL-37, PD-6), ported from `FeaturedPhotoDialog` in
   * design/frameleaf/template/src/People.jsx:587-640. It replaces the person page's select
   * mode: the person's photos in a grid, and choosing one writes `featureFaceAssetId` through
   * `updatePerson`. The photos come from the existing metadata search filtered to this person
   * and to the timeline; a Locked photo is never offered, so it can never become the face
   * that represents someone across the app.
   */
  interface Props {
    person: PersonResponseDto;
    open?: boolean;
    onSelected?: (person: PersonResponseDto) => void;
  }

  let { person, open = $bindable(false), onSelected }: Props = $props();

  const PAGE_SIZE = 120;

  let assets: AssetResponseDto[] = $state([]);
  let nextPage: string | null = $state(null);
  let loading = $state(false);
  let failed = $state(false);
  let chosen: string | null = $state(null);
  let busy = $state(false);
  const name = $derived(isUnnamedPerson(person) ? $t('unnamed_person') : person.name);

  const load = async (page?: string) => {
    loading = true;
    failed = false;
    try {
      const { assets: result } = await searchAssets({
        metadataSearchDto: {
          personIds: [person.id],
          visibility: AssetVisibility.Timeline,
          size: PAGE_SIZE,
          page: page ? Number(page) : undefined,
        },
      });
      const items = result.items.filter((asset) => asset.visibility !== AssetVisibility.Locked);
      assets = page ? [...assets, ...items] : items;
      nextPage = result.nextPage;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  };

  $effect(() => {
    if (!open) {
      return;
    }

    assets = [];
    chosen = null;
    void load();
  });

  const select = async (asset: AssetResponseDto) => {
    if (busy) {
      return;
    }
    busy = true;
    chosen = asset.id;
    try {
      const updated = await updatePerson({ id: person.id, personUpdateDto: { featureFaceAssetId: asset.id } });
      eventManager.emit('PersonUpdate', updated);
      open = false;
      onSelected?.(updated);
    } catch (error) {
      chosen = null;
      handleError(error, $t('errors.unable_to_set_feature_photo'));
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('select_featured_photo')} closeLabel={$t('close')} wide bind:open>
  <p class="hint">{$t('frameleaf_people_featured_hint', { values: { name } })}</p>
  {#if failed}
    <Status message={$t('frameleaf_people_featured_failed')} />
    <Button onclick={() => void load()}>{$t('retry')}</Button>
  {:else if !loading && assets.length === 0}
    <p class="empty">{$t('frameleaf_people_featured_empty')}</p>
  {:else}
    <div class="grid" role="radiogroup" aria-label={$t('photos')}>
      {#each assets as asset, index (asset.id)}
        <button
          type="button"
          role="radio"
          class="tile"
          class:current={chosen === asset.id}
          aria-checked={chosen === asset.id}
          aria-label={asset.originalFileName}
          disabled={busy}
          data-initial-focus={index === 0 ? '' : undefined}
          onclick={() => void select(asset)}
        >
          <img src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
          {#if asset.type === AssetTypeEnum.Video}
            <span class="video" aria-hidden="true"><Icon icon={mdiPlay} size="14" /></span>
          {/if}
          {#if chosen === asset.id}
            <span class="check" aria-hidden="true"><Icon icon={mdiCheck} size="16" /></span>
          {/if}
        </button>
      {/each}
    </div>
    {#if loading}
      <Status message={$t('loading')} busy />
    {:else if nextPage}
      <div class="more">
        <Button onclick={() => void load(nextPage!)}>{$t('frameleaf_people_show_more')}</Button>
      </div>
    {/if}
  {/if}
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('done')}</Button>
  {/snippet}
</Dialog>

<style>
  /* template/src/people.css `.pp-featured-*`. */
  .hint {
    margin: 0 0 16px;
    color: var(--fl-muted);
    line-height: 1.5;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
    gap: 10px;
  }
  .tile {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    aspect-ratio: 1;
    padding: 0;
    overflow: hidden;
    background: var(--fl-raised);
    border: 2px solid transparent;
    border-radius: var(--fl-radius-card);
  }
  .tile img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .tile:hover {
    border-color: var(--fl-muted);
  }
  .tile.current {
    border-color: var(--fl-accent);
  }
  .video,
  .check {
    position: absolute;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    color: #fff;
    background: #000a;
    border-radius: 50%;
  }
  .video {
    left: 6px;
    bottom: 6px;
  }
  .check {
    top: 6px;
    right: 6px;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
  }
  .empty {
    color: var(--fl-muted);
  }
  .more {
    display: flex;
    justify-content: center;
    margin-top: 12px;
  }
  @media (max-width: 700px) {
    .grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
</style>
