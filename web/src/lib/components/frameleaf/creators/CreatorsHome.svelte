<script lang="ts">
  import { getNewMediaCreatorItems, type MediaCreatorItemResponse } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import {
    creatorBannerUrl,
    creatorItemImage,
    creatorPlatform,
    creatorsHref,
    creatorState,
    creatorStatus,
    mediaLength,
    platformName,
    postedDate,
  } from '$lib/frameleaf/creators';
  import { creatorsStore } from '$lib/frameleaf/creators-store.svelte';
  import type { MediaPlatform } from '$lib/frameleaf/media-address';
  import CreatorAvatar from './CreatorAvatar.svelte';
  import CreatorsAddBox from './CreatorsAddBox.svelte';
  import PlatformMark from './PlatformMark.svelte';

  /** Creators' home (prototype `Home`): the add box, what is new, and everyone followed or added. */
  let {
    onDone,
    onOpenItem,
  }: {
    onDone: (message: string, creatorId?: string) => void;
    onOpenItem: (item: MediaCreatorItemResponse) => void;
  } = $props();

  const controller = new AbortController();
  let address = $state('');
  let fresh = $state<MediaCreatorItemResponse[]>([]);
  let freshFailed = $state(false);
  let platform = $state<MediaPlatform | 'all'>('all');

  const creators = $derived(creatorsStore.creators);
  const byId = $derived(new Map(creators.map((creator) => [creator.id, creator])));
  const platforms = $derived([...new Set(creators.map(({ provider, url }) => creatorPlatform(provider, url)))]);
  const shown = $derived(
    creators.filter(({ provider, url }) => platform === 'all' || creatorPlatform(provider, url) === platform),
  );

  const loadFresh = async () => {
    freshFailed = false;
    try {
      const { items } = await getNewMediaCreatorItems({}, { signal: controller.signal });
      fresh = items;
    } catch {
      if (!controller.signal.aborted) {
        freshFailed = true;
      }
    }
  };

  onMount(() => {
    void loadFresh();
    return () => controller.abort();
  });
</script>

<header class="cr-head" class:adding={!!address.trim()}>
  <h1>{$t('frameleaf_creators_title')}</h1>
  <p>{$t('frameleaf_creators_intro')}</p>
  <CreatorsAddBox
    bind:address
    onDone={(message, creatorId) => {
      address = '';
      onDone(message, creatorId);
    }}
  />
</header>
{#if !address.trim()}
  <div class="cr-scroll">
    <section aria-labelledby="cr-new-heading">
      <h2 id="cr-new-heading">
        {$t('frameleaf_creators_new_heading')}
        <small>{Math.max(creatorsStore.newCount, fresh.length)}</small>
      </h2>
      {#if freshFailed}
        <InlineError compact message={$t('frameleaf_creators_load_error')} onRetry={loadFresh} />
      {:else if fresh.length > 0}
        <ul class="cr-row">
          {#each fresh as item (item.assetId)}
            {@const creator = byId.get(item.creatorId)}
            {@const length = mediaLength(item.duration)}
            <li>
              <button type="button" onclick={() => onOpenItem(item)}>
                <span class="cr-thumb">
                  <img src={creatorItemImage(item)} alt="" loading="lazy" />
                  {#if length}<span class="cr-length">{length}</span>{/if}
                </span>
                <strong>{item.title || item.description || $t(`frameleaf_creators_kind_${item.kind}`)}</strong>
                <small>
                  {#if creator}
                    <PlatformMark
                      platform={creatorPlatform(creator.provider, creator.url)}
                      provider={creator.provider}
                      size={12}
                    />
                    {creator.name} ·
                  {/if}
                  {postedDate(item.publishedAt ?? item.savedAt, $locale)}
                </small>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="cr-empty">{$t('frameleaf_creators_nothing_new')}</p>
      {/if}
    </section>
    <section aria-labelledby="cr-all-heading">
      <div class="cr-section-head">
        <h2 id="cr-all-heading">{$t('frameleaf_creators_everyone')}</h2>
        {#if platforms.length > 1}
          <div class="cr-chips" role="group" aria-label={$t('frameleaf_creators_platform')}>
            <button type="button" class="cr-chip" aria-pressed={platform === 'all'} onclick={() => (platform = 'all')}>
              {$t('frameleaf_creators_all')}
            </button>
            {#each platforms as id (id)}
              <button type="button" class="cr-chip" aria-pressed={platform === id} onclick={() => (platform = id)}>
                <PlatformMark platform={id} />
                {platformName(id) || $t('frameleaf_creators_platform_website')}
              </button>
            {/each}
          </div>
        {/if}
      </div>
      {#if shown.length > 0}
        <ul class="cr-cards">
          {#each shown as creator (creator.id)}
            {@const status = creatorStatus(creator, $locale)}
            <li class="cr-card {creatorState(creator)}">
              <a href={creatorsHref({ creator: creator.id })}>
                {#if creator.hasBanner}
                  <img class="cr-banner" src={creatorBannerUrl(creator.id)} alt="" loading="lazy" />
                {:else}
                  <span class="cr-banner"></span>
                {/if}
                <span class="cr-card-body">
                  <CreatorAvatar {creator} size={44} />
                  <span>
                    <strong>
                      {creator.name}
                      <PlatformMark
                        platform={creatorPlatform(creator.provider, creator.url)}
                        provider={creator.provider}
                      />
                    </strong>
                    <small>{$t(status.key, { values: status.values })}</small>
                    <small>
                      {$t('frameleaf_creators_saved_count', {
                        values: { count: creator.savedCount },
                      })}{#if creator.newCount > 0}<em
                          >{$t('frameleaf_creators_new_suffix', { values: { count: creator.newCount } })}</em
                        >{/if}
                    </small>
                  </span>
                </span>
              </a>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="cr-empty">{$t('frameleaf_creators_no_one')}</p>
      {/if}
    </section>
  </div>
{/if}
