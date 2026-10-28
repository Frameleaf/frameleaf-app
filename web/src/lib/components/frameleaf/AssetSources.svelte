<script lang="ts">
  import { getAssetSources, type AssetSourceResponseDto } from '@frameleaf/sdk';
  import { onDestroy } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { libraryReferenceUrl } from '$lib/frameleaf/library-reference';

  let { assetId, canRead = false }: { assetId: string; canRead?: boolean } = $props();
  let sources = $state<AssetSourceResponseDto[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let generation = $state(0);
  $effect(() => {
    const id = assetId;
    const version = generation;
    sources = [];
    failed = false;
    loading = false;
    if (!canRead) {
      return;
    }
    const controller = new AbortController();
    loading = true;
    void getAssetSources({ id }, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted && canRead && assetId === id && generation === version) {
          sources = value;
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && canRead && assetId === id && generation === version) {
          failed = true;
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && assetId === id && generation === version) {
          loading = false;
        }
      });
    return () => controller.abort();
  });
  onDestroy(
    onLibraryAccessChange(() => {
      sources = [];
      generation++;
    }),
  );
</script>

{#if canRead}
  <section class="fl-asset-sources" aria-label={$t('frameleaf_sources_title')} aria-busy={loading}>
    <h3>{$t('frameleaf_sources_title')}</h3>
    {#if loading}<p role="status">{$t('loading')}</p>
    {:else if failed}
      <p role="status">{$t('frameleaf_sources_unavailable')}</p>
      <Button onclick={() => generation++}>{$t('retry')}</Button>
    {:else if sources.length === 0}<p>{$t('frameleaf_sources_empty')}</p>
    {:else}
      <ul>
        {#each sources as source (source.id)}
          {@const pageUrl = libraryReferenceUrl(source.pageUrl)}
          {@const mediaUrl = libraryReferenceUrl(source.mediaUrl)}
          {@const licenseUrl = libraryReferenceUrl(source.licenseUrl)}
          <li>
            {#if pageUrl}<a href={pageUrl} target="_blank" rel="noopener noreferrer">{source.title || pageUrl}</a
              >{:else}<span>{source.title}</span>{/if}
            <time datetime={source.capturedAt}
              >{new Date(source.capturedAt).toLocaleDateString($locale ?? undefined, { dateStyle: 'medium' })}</time
            >
            {#if source.creator}<p>{source.creator}</p>{/if}
            <div class="fl-source-links">
              {#if mediaUrl}<a href={mediaUrl} target="_blank" rel="noopener noreferrer"
                  >{$t('frameleaf_sources_original_link')}</a
                >{/if}
              {#if licenseUrl}<a href={licenseUrl} target="_blank" rel="noopener noreferrer"
                  >{$t('frameleaf_sources_license')}</a
                >{/if}
            </div>
            {#if source.note}<p class="fl-source-note">{source.note}</p>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .fl-asset-sources {
    display: grid;
    min-width: 0;
    gap: var(--fl-space-2);
  }
  h3 {
    margin: 0;
    font-size: var(--fl-font-size);
    font-weight: 600;
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
    gap: var(--fl-space-1);
    padding-block-end: var(--fl-space-3);
    border-block-end: 1px solid var(--fl-border);
    overflow-wrap: anywhere;
  }
  li:last-child {
    padding-block-end: 0;
    border: 0;
  }
  a {
    color: var(--fl-accent);
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }
  a:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
    border-radius: var(--fl-radius-control);
  }
  p,
  time {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fl-source-links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
    font-size: var(--fl-font-small);
  }
  .fl-source-note {
    color: var(--fl-text);
    white-space: pre-wrap;
  }
</style>
