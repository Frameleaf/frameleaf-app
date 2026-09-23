<script lang="ts">
  /**
   * Frameleaf Memories index (FL-62).
   *
   * Ported from the approved prototype (`design/frameleaf/template/src/Memories.jsx`), but
   * built entirely against the real memories API through `memoryManager`
   * (`$lib/managers/memory-manager.svelte`) rather than the prototype's client-derived
   * "on this day / years ago / event / best-of" index, which was derived on the client.
   * Memories are generated ahead of time and exposed as `isUpcoming` (via `showAt`) versus
   * already current.
   *
   * The server slice of this story added two more generated kinds beside `on_this_day`:
   * `event_story`, a multi-day trip or occasion grouped from the owner's local capture time
   * and place, and `year_in_review`, a yearly recap. They arrive through the same memories
   * endpoint, so the index reads the kind off each memory's own data (see
   * `$lib/frameleaf/memory-stories`) and labels the card rather than guessing.
   *
   * The prototype's per-card menu offered Play, Favorite and Hide. There is no "hide"
   * concept in the real API (only permanent removal), so this ports it as "Remove memory"
   * (`memoryManager.removeMemory`), matching the action the legacy viewer already exposed.
   */
  import { clickOutside } from '$lib/actions/click-outside';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import Toggle from '$lib/components/frameleaf/Toggle.svelte';
  import {
    formatLocalDateRange,
    isEventStory,
    memoryStoryKind,
    type MemoryStoryKind,
  } from '$lib/frameleaf/memory-stories';
  import { memoryManager } from '$lib/managers/memory-manager.svelte';
  import { userPreferencesManager, type MemoriesPreferences } from '$lib/managers/user-preferences-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl, memoryLaneTitle } from '$lib/utils';
  import { getAltText } from '$lib/utils/thumbnail-util';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import type { MemoryResponseDto } from '@immich/sdk';
  import { Icon, LoadingSpinner } from '@immich/ui';
  import { locale } from '$lib/stores/preferences.store';
  import {
    mdiCalendarHeart,
    mdiCalendarStar,
    mdiDeleteOutline,
    mdiDotsVertical,
    mdiHeart,
    mdiHeartOutline,
    mdiImageMultipleOutline,
    mdiMapMarkerPath,
    mdiPlay,
    mdiTune,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  const isUpcoming = (memory: MemoryResponseDto) => !!memory.showAt && new Date(memory.showAt).getTime() > Date.now();
  const upcoming = $derived(memoryManager.memories.filter((memory) => isUpcoming(memory)));
  const current = $derived(memoryManager.memories.filter((memory) => !isUpcoming(memory)));

  /**
   * FL-62: the server now generates three kinds of memory and serves them all through the
   * same endpoint, so the index labels each card with the kind it is rather than presenting
   * an undifferentiated grid. The kind comes from the memory's own data, never from a
   * client-side guess.
   */
  const KIND_ICON: Record<MemoryStoryKind, string> = {
    on_this_day: mdiCalendarHeart,
    event_story: mdiMapMarkerPath,
    year_in_review: mdiCalendarStar,
  };

  const KIND_LABEL = (kind: MemoryStoryKind) => {
    switch (kind) {
      case 'event_story': {
        return $t('frameleaf_memories_kind_event_story');
      }
      case 'year_in_review': {
        return $t('frameleaf_memories_kind_year_in_review');
      }
      default: {
        return $t('frameleaf_memories_kind_on_this_day');
      }
    }
  };

  let status = $state('');
  let settingsOpen = $state(false);

  const cardHref = (memory: MemoryResponseDto) =>
    Route.viewMemory({
      id: memory.id,
      assetId: memory.assets[0].id,
      isSaved: userPreferencesManager.memories.onlyFavorites || undefined,
    });

  const toggleFavorite = async (memory: MemoryResponseDto) => {
    const title = $memoryLaneTitle(memory);
    await memoryManager.toggleMemorySaved(memory.id);
    status = memory.isSaved
      ? $t('frameleaf_memories_added_to_favorites', { values: { title } })
      : $t('frameleaf_memories_removed_from_favorites', { values: { title } });
  };

  const removeMemory = async (memory: MemoryResponseDto) => {
    const title = $memoryLaneTitle(memory);
    await memoryManager.removeMemory(memory.id);
    status = $t('frameleaf_memories_removed', { values: { title } });
  };

  const applySetting = async (patch: Partial<MemoriesPreferences>) => {
    userPreferencesManager.memories = { ...userPreferencesManager.memories, ...patch };
    await memoryManager.applyPreferences();
  };
</script>

{#snippet card(memory: MemoryResponseDto, size: 'hero' | 'regular')}
  {@const cover = memory.assets[0]}
  <article class="fm-card {size}" class:favorite={memory.isSaved}>
    <a class="fm-card-main" href={cardHref(memory)} aria-label={`${$t('play')}: ${$memoryLaneTitle(memory)}`}>
      {#if cover}
        <img src={getAssetMediaUrl({ id: cover.id })} alt={$getAltText(toTimelineAsset(cover))} loading="lazy" />
      {:else}
        <span class="fm-card-empty" aria-hidden="true"><Icon icon={mdiImageMultipleOutline} size={28} /></span>
      {/if}
      <span class="fm-card-shade" aria-hidden="true"></span>
      <span class="fm-card-copy">
        <span class="fm-card-kind">
          <Icon icon={KIND_ICON[memoryStoryKind(memory)]} size={12} aria-hidden="true" />
          {KIND_LABEL(memoryStoryKind(memory))}
        </span>
        <strong>{$memoryLaneTitle(memory)}</strong>
        <small>
          {#if isEventStory(memory)}
            {formatLocalDateRange(memory.data.startDate, memory.data.endDate, $locale)}
            ·
            {$t('frameleaf_memories_story_days', { values: { count: memory.data.dayCount } })}
            ·
          {/if}
          {$t('frameleaf_memories_item_count', { values: { count: memory.assets.length } })}
          {#if memory.isSaved}
            · <Icon icon={mdiHeart} size={12} aria-hidden="true" /> {$t('favorite')}
          {/if}
        </small>
      </span>
      <span class="fm-card-play" aria-hidden="true"><Icon icon={mdiPlay} size={20} /></span>
    </a>
    <div class="fm-card-menu">
      <Menu label={$t('frameleaf_memories_more_actions', { values: { title: $memoryLaneTitle(memory) } })}>
        {#snippet trigger()}<Icon icon={mdiDotsVertical} size={16} aria-hidden="true" />{/snippet}
        <MenuItem onSelect={() => toggleFavorite(memory)}>
          <Icon icon={memory.isSaved ? mdiHeart : mdiHeartOutline} size={16} aria-hidden="true" />
          {memory.isSaved ? $t('unfavorite') : $t('favorite')}
        </MenuItem>
        <MenuItem onSelect={() => removeMemory(memory)}>
          <Icon icon={mdiDeleteOutline} size={16} aria-hidden="true" />
          {$t('remove_memory')}
        </MenuItem>
      </Menu>
    </div>
  </article>
{/snippet}

<div class="fm">
  <header class="fm-header">
    <div>
      <h1>{$t('memories')}</h1>
      <p>
        {memoryManager.total === undefined
          ? ''
          : $t('frameleaf_memories_subtitle', { values: { count: memoryManager.total } })}
      </p>
    </div>
    <div
      class="fm-header-actions"
      use:clickOutside={{ onOutclick: () => (settingsOpen = false), onEscape: () => (settingsOpen = false) }}
    >
      <IconButton
        variant={userPreferencesManager.hasMemoryPreferences() ? 'primary' : 'default'}
        label={$t('filters')}
        pressed={settingsOpen}
        onclick={() => (settingsOpen = !settingsOpen)}
      >
        <Icon icon={mdiTune} size={18} />
      </IconButton>
      {#if settingsOpen}
        <div class="fm-settings" role="dialog" aria-label={$t('filters')}>
          <div class="fm-setting-row">
            <span>
              <strong>{$t('memories_show_upcoming')}</strong>
              <small>{$t('frameleaf_memories_show_upcoming_description')}</small>
            </span>
            <Toggle
              label={$t('memories_show_upcoming')}
              checked={userPreferencesManager.memories.showUpcoming}
              onLabel={$t('enabled')}
              offLabel={$t('disabled')}
              onChange={(checked) => applySetting({ showUpcoming: checked })}
            />
          </div>
          <div class="fm-setting-row">
            <span>
              <strong>{$t('only_favorites')}</strong>
              <small>{$t('frameleaf_memories_only_favorites_description')}</small>
            </span>
            <Toggle
              label={$t('only_favorites')}
              checked={userPreferencesManager.memories.onlyFavorites}
              onLabel={$t('enabled')}
              offLabel={$t('disabled')}
              onChange={(checked) => applySetting({ onlyFavorites: checked })}
            />
          </div>
        </div>
      {/if}
    </div>
  </header>

  <Status message={status} />

  {#if upcoming.length > 0}
    <section class="fm-section" aria-label={$t('memories_upcoming')}>
      <h2>{$t('memories_upcoming')}</h2>
      <div class="fm-row">
        {#each upcoming as memory (memory.id)}
          {@render card(memory, 'regular')}
        {/each}
      </div>
    </section>
  {/if}

  <section class="fm-section" aria-label={$t('memories_current')}>
    {#if upcoming.length > 0}
      <h2>{$t('memories_current')}</h2>
    {/if}
    {#if current.length > 0}
      <div class="fm-grid">
        {#each current as memory, index (memory.id)}
          {@render card(memory, index === 0 ? 'hero' : 'regular')}
        {/each}
      </div>
    {:else if memoryManager.loading}
      <div class="fm-loading"><LoadingSpinner size="giant" /></div>
    {:else}
      <div class="fm-empty" role="status">
        <Icon icon={mdiImageMultipleOutline} size={30} aria-hidden="true" />
        <strong>{$t('frameleaf_memories_empty_title')}</strong>
        <p>
          {userPreferencesManager.memories.onlyFavorites
            ? $t('frameleaf_memories_empty_favorites')
            : $t('frameleaf_memories_empty_description')}
        </p>
      </div>
    {/if}
  </section>
</div>

<style>
  .fm {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    color: var(--fl-text);
  }
  .fm-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }
  .fm-header h1 {
    font-size: 1.25rem;
  }
  .fm-header p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fm-header-actions {
    position: relative;
  }
  .fm-settings {
    position: absolute;
    inset-inline-end: 0;
    top: calc(100% + 0.375rem);
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 16rem;
    padding: 0.75rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
  }
  .fm-setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .fm-setting-row span {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .fm-setting-row small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fm-section h2 {
    margin-block-end: 0.5rem;
    font-size: 1rem;
  }
  .fm-row {
    display: flex;
    gap: 0.75rem;
    overflow-x: auto;
    padding-block-end: 0.25rem;
  }
  .fm-row .fm-card {
    flex: 0 0 16rem;
  }
  .fm-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
    gap: 0.75rem;
  }
  .fm-card {
    /* overflow stays visible here (unlike .fm-card-main below) so the per-card menu is
       never clipped by the cover image's rounded corners; the radius alone still keeps
       this box's own background from peeking past .fm-card-main's rounded corners. */
    position: relative;
    aspect-ratio: 4 / 3;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .fm-card.hero {
    grid-column: span 2;
    aspect-ratio: 16 / 9;
  }
  @media (max-width: 40rem) {
    .fm-card.hero {
      grid-column: span 1;
    }
  }
  .fm-card-main {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    border-radius: var(--fl-radius-card);
    overflow: hidden;
  }
  .fm-card-main img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .fm-card-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--fl-muted);
  }
  .fm-card-shade {
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgb(0 0 0 / 65%), transparent 55%);
  }
  .fm-card-copy {
    position: absolute;
    inset-inline-start: 0.75rem;
    inset-block-end: 0.625rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    color: #fff;
  }
  .fm-card-kind {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 0.25rem;
    padding: 0.0625rem 0.4375rem;
    margin-block-end: 0.125rem;
    border-radius: 999px;
    background: rgb(0 0 0 / 45%);
    font-size: var(--fl-font-small);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .fm-card-copy strong {
    font-size: 0.9375rem;
  }
  .fm-card-copy small {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    opacity: 0.85;
    font-size: var(--fl-font-small);
  }
  .fm-card-play {
    position: absolute;
    inset-inline-end: 0.625rem;
    inset-block-start: 0.625rem;
    display: inline-flex;
    padding: 0.375rem;
    color: #fff;
    background: rgb(0 0 0 / 35%);
    border-radius: 50%;
  }
  .fm-card-menu {
    position: absolute;
    inset-inline-start: 0.375rem;
    inset-block-start: 0.375rem;
  }
  .fm-card-menu :global(button) {
    color: #fff;
    background: rgb(0 0 0 / 35%);
    border-color: transparent;
  }
  .fm-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3rem 0;
  }
  .fm-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 3rem 1rem;
    color: var(--fl-muted);
    text-align: center;
  }
</style>
