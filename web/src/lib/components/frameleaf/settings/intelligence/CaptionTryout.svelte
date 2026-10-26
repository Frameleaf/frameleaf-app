<script lang="ts">
  /**
   * Descriptions & tags › "Try it on a few photos" in place (FL-537, after the prototype's `Samples`
   * in `settings-v2/care/captions.jsx`). Writes captions for three recent photos with the choices on
   * the page as they are now (saved or not), through the server's enrichment preview, which runs them
   * at once and stores nothing. The full workbench (more samples, another computer) stays one click away.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import {
    AssetMediaSize,
    AssetOrder,
    AssetTypeEnum,
    EnrichmentPreviewStatus,
    previewEnrichment,
    searchAssets,
    type AdminConfigImageDescriptionDto,
    type AssetResponseDto,
    type EnrichmentPreviewSampleDto,
  } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const SAMPLES = 3;

  let {
    draft,
    disabled = false,
    onOpenWorkbench,
  }: { draft: AdminConfigImageDescriptionDto; disabled?: boolean; onOpenWorkbench: () => void } = $props();

  let photos = $state<AssetResponseDto[]>([]);
  let samples = $state<EnrichmentPreviewSampleDto[]>([]);
  let phase = $state<'writing' | 'done' | 'none' | 'failed'>('writing');
  /** The choices the samples were written with, so the page can offer to write them again. */
  let triedWith = $state('');
  const choices = $derived(JSON.stringify([draft.modelName, draft.fallbackModelName, draft.prompt]));

  const write = async () => {
    phase = 'writing';
    triedWith = choices;
    try {
      if (photos.length === 0) {
        const { assets } = await searchAssets({
          metadataSearchDto: { size: SAMPLES, order: AssetOrder.Desc, type: AssetTypeEnum.Image },
        });
        photos = assets.items.slice(0, SAMPLES);
      }
      if (photos.length === 0) {
        phase = 'none';
        return;
      }
      const preview = await previewEnrichment({
        enrichmentPreviewRequestDto: {
          assetIds: photos.map(({ id }) => id),
          modelName: draft.modelName,
          fallbackModelName: draft.fallbackModelName,
          prompt: draft.prompt,
        },
      });
      samples = preview.samples;
      phase = 'done';
    } catch {
      phase = 'failed';
    }
  };

  onMount(() => {
    void write();
  });

  const photoOf = (assetId: string) => photos.find(({ id }) => id === assetId);
</script>

<div class="tryout" aria-label={$t('frameleaf_intel_captions_samples')} aria-busy={phase === 'writing'}>
  {#if phase === 'writing'}
    <p class="hint" role="status">{$t('frameleaf_intel_captions_writing')}</p>
  {:else if phase === 'none'}
    <p class="hint">{$t('frameleaf_intel_captions_no_photos')}</p>
  {:else if phase === 'failed'}
    <p class="hint" role="alert">{$t('frameleaf_intel_captions_try_failed')}</p>
  {:else}
    <ul>
      {#each samples as sample (sample.assetId)}
        {@const photo = photoOf(sample.assetId)}
        <li>
          {#if photo}
            <img
              src={getAssetMediaUrl({ id: photo.id, cacheKey: photo.thumbhash, size: AssetMediaSize.Thumbnail })}
              alt=""
            />
          {/if}
          <div>
            {#if sample.status === EnrichmentPreviewStatus.Success && sample.candidate}
              <p>{sample.candidate}</p>
              {#if sample.tags.length > 0}
                <small>{$t('frameleaf_intel_captions_sample_tags', { values: { tags: sample.tags.join(', ') } })}</small
                >
              {/if}
            {:else}
              <p class="hint">{$t('frameleaf_intel_captions_sample_failed')}</p>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="actions">
    {#if phase !== 'writing' && (choices !== triedWith || phase === 'failed')}
      <Button {disabled} onclick={write}>{$t('frameleaf_intel_captions_try_again')}</Button>
    {/if}
    <Button {disabled} onclick={onOpenWorkbench}>{$t('frameleaf_intel_captions_try_more')}</Button>
  </div>
</div>

<style>
  .tryout {
    display: grid;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3) 0;
  }
  ul {
    display: grid;
    gap: var(--fl-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    grid-template-columns: 4rem minmax(0, 1fr);
    gap: var(--fl-space-3);
    align-items: start;
  }
  img {
    width: 4rem;
    height: 4rem;
    object-fit: cover;
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
  }
  li p {
    margin: 0;
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
  }
  li small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
</style>
