<script lang="ts">
  /**
   * Frameleaf Memories index (FL-62), ported from the September 24 prototype
   * (`design/frameleaf/template/src/Memories.jsx`, `discovery.css:887-1070`, `memories.css`) and built
   * entirely on the real memories API through `memoryManager`, never on the prototype's sample data.
   *
   * - Sections Today, Upcoming ("Next 14 days") and Earlier ("Trips and highlights"), decided from the
   *   viewer's own local date (Memories.jsx:260-360): a birthday by the local date in its data, an "on
   *   this day" memory by its show window; trips, highlights and recaps are Earlier. Upcoming cards read
   *   "Tomorrow" / "In N days", recently passed ones "Yesterday" / "N days ago".
   * - With nothing for today, a quiet card names the day and when the next memory arrives.
   * - Each card's menu: Play, Favorite or Remove from favorites, then show less of its person or pet,
   *   its day or its kind (not in the prototype; composed as more menu items, like its menu), then
   *   Hide memory. Hiding replaces deletion (MI-1): hidden memories wait under "Hidden memories",
   *   collapsed to "Show N", where Restore brings them back.
   * - Memory settings (the gear): Show upcoming, Only favorites and the owner's show-less rules, each
   *   of which can be removed again.
   * - The card overline comes from the shared Memories engine and the cover plays its slow pan-and-zoom
   *   preview on hover and keyboard focus; under Reduce Motion the cover holds still.
   *
   * The server already leaves Locked items out of memories; a cover is never a Locked item regardless.
   */
  import { goto } from '$app/navigation';
  import { clickOutside } from '$lib/actions/click-outside';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { memoryMotionStyle, memoryOverlineKey, memoryPreviewMotion } from '$lib/frameleaf/memory-engine';
  import {
    groupMemories,
    localToday,
    memoryStoryKind,
    showLessOptions,
    showLessRuleLabel,
    type MemoryEntry,
    type MemoryStoryKind,
  } from '$lib/frameleaf/memory-stories';
  import { prefersReducedMotion } from '$lib/frameleaf/motion';
  import { memoryManager } from '$lib/managers/memory-manager.svelte';
  import { userPreferencesManager, type MemoriesPreferences } from '$lib/managers/user-preferences-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl, memoryHeadline } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    AssetVisibility,
    type MemoryResponseDto,
    type MemoryShowLessDto,
    type MemoryShowLessResponseDto,
  } from '@immich/sdk';
  import { Icon, LoadingSpinner } from '@immich/ui';
  import {
    mdiAccountHeartOutline,
    mdiCakeVariantOutline,
    mdiCalendarTodayOutline,
    mdiChevronDown,
    mdiChevronUp,
    mdiCogOutline,
    mdiDotsVertical,
    mdiEyeOffOutline,
    mdiHeart,
    mdiHeartOutline,
    mdiHistory,
    mdiImageMultipleOutline,
    mdiMapMarkerOutline,
    mdiMinusCircleOutline,
    mdiPlay,
    mdiRestore,
    mdiStarOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import { t } from 'svelte-i18n';

  /** Memories.jsx:20-25, plus the two server kinds the template has no card for. */
  const KIND_ICON: Record<MemoryStoryKind, string> = {
    on_this_day: mdiCalendarTodayOutline,
    event_story: mdiMapMarkerOutline,
    year_in_review: mdiStarOutline,
    birthday: mdiCakeVariantOutline,
    person_recap: mdiAccountHeartOutline,
  };

  // "Today" is the viewer's local day, and it moves on at midnight while the page stays open.
  let today = $state(localToday());
  onMount(() => {
    const timer = setInterval(() => (today = localToday()), 60_000);
    void memoryManager.loadHidden().catch((error) => handleError(error, $t('errors.something_went_wrong')));
    void memoryManager.loadShowLess().catch((error) => handleError(error, $t('errors.something_went_wrong')));
    return () => clearInterval(timer);
  });

  const preferences = $derived(userPreferencesManager.memories);
  const sections = $derived(groupMemories(memoryManager.memories, { today, showUpcoming: preferences.showUpcoming }));
  const nothing = $derived(
    sections.today.length === 0 && sections.upcoming.length === 0 && sections.earlier.length === 0,
  );
  const nextUp = $derived(sections.upcoming[0]);
  const longToday = $derived(
    DateTime.fromISO(today)
      .setLocale($locale ?? 'en')
      .toLocaleString(DateTime.DATE_FULL),
  );

  const coverOf = (memory: MemoryResponseDto | undefined) =>
    memory?.assets.find((asset) => asset.visibility !== AssetVisibility.Locked);
  const quietCover = $derived(coverOf(sections.earlier[0]?.memory ?? sections.upcoming[0]?.memory));

  let status = $state('');
  let settingsOpen = $state(false);
  let showHidden = $state(false);
  let gear: HTMLButtonElement | undefined = $state();

  const cardHref = (memory: MemoryResponseDto) => {
    const first = memory.assets[0];
    return first
      ? Route.viewMemory({ id: memory.id, assetId: first.id, isSaved: preferences.onlyFavorites || undefined })
      : undefined;
  };

  const play = (memory: MemoryResponseDto) => {
    const href = cardHref(memory);
    if (href) {
      void goto(href);
    }
  };

  const run = async (action: () => Promise<void>, message: string) => {
    try {
      await action();
      status = message;
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };

  const toggleFavorite = (memory: MemoryResponseDto) => {
    const title = $memoryHeadline(memory).title;
    const message = memory.isSaved
      ? $t('frameleaf_memories_removed_from_favorites', { values: { title } })
      : $t('frameleaf_memories_added_to_favorites', { values: { title } });
    return run(() => memoryManager.toggleMemorySaved(memory.id), message);
  };

  const hide = (memory: MemoryResponseDto) =>
    run(
      () => memoryManager.hideMemory(memory.id),
      $t('frameleaf_memories_hidden_status', { values: { title: $memoryHeadline(memory).title } }),
    );

  const restore = (memory: MemoryResponseDto) =>
    run(
      () => memoryManager.restoreMemory(memory.id),
      $t('frameleaf_memories_restored', { values: { title: $memoryHeadline(memory).title } }),
    );

  const showLess = (rule: MemoryShowLessDto) =>
    run(() => memoryManager.addShowLess(rule), $t('frameleaf_memories_show_less_added'));

  const showAgain = (rule: MemoryShowLessResponseDto) =>
    run(
      () => memoryManager.removeShowLess(rule),
      $t('frameleaf_memories_show_less_removed', { values: { label: ruleLabel(rule) } }),
    );

  const ruleLabel = (rule: MemoryShowLessResponseDto) => showLessRuleLabel(rule, { t: $t, locale: $locale });

  const applySetting = async (patch: Partial<MemoriesPreferences>) => {
    userPreferencesManager.memories = { ...userPreferencesManager.memories, ...patch };
    await memoryManager.applyPreferences();
  };

  const closeSettings = (refocus: boolean) => {
    settingsOpen = false;
    if (refocus) {
      gear?.focus();
    }
  };

  /** Memories.jsx:238: the first switch takes focus when the popover opens. */
  const focusFirst: Attachment<HTMLElement> = (element) => {
    element.querySelector<HTMLElement>('[role="switch"]')?.focus();
  };

  const badge = (entry: MemoryEntry) => {
    if (entry.inDays) {
      return $t('frameleaf_memories_in_days', { values: { count: entry.inDays } });
    }
    if (entry.passedDays) {
      return $t('frameleaf_memories_days_ago', { values: { count: entry.passedDays } });
    }
  };
</script>

{#snippet coverImage(memory: MemoryResponseDto | undefined, motion: boolean)}
  {@const cover = coverOf(memory)}
  {#if cover}
    <img
      class="fm-cover"
      src={getAssetMediaUrl({ id: cover.id, size: AssetMediaSize.Preview })}
      alt=""
      loading="lazy"
      draggable="false"
      style={motion ? memoryMotionStyle(memoryPreviewMotion(cover.id, prefersReducedMotion())) : undefined}
    />
  {:else}
    <span class="fm-cover-empty" aria-hidden="true"><Icon icon={mdiImageMultipleOutline} size="28" /></span>
  {/if}
{/snippet}

{#snippet card(entry: MemoryEntry, size: 'hero' | 'regular')}
  {@const memory = entry.memory}
  {@const headline = $memoryHeadline(memory)}
  {@const count = $t('frameleaf_memories_item_count', { values: { count: memory.assets.length } })}
  {@const kind = memoryStoryKind(memory)}
  <article class="fm-card {size}" class:favorite={memory.isSaved}>
    <a
      class="fm-card-main"
      href={cardHref(memory)}
      aria-label={$t('frameleaf_memories_play_label', {
        values: { title: headline.title, subtitle: headline.subtitle, count },
      })}
    >
      {@render coverImage(memory, true)}
      <span class="fm-shade" aria-hidden="true"></span>
      <span class="fm-card-copy">
        <span class="fm-overline">
          <Icon icon={KIND_ICON[kind]} size="14" aria-hidden="true" />
          {badge(entry) ?? $t(memoryOverlineKey(kind))}
        </span>
        <strong>{headline.title}</strong>
        {#if headline.subtitle}
          <small>{headline.subtitle}</small>
        {/if}
        <small class="fm-card-count">
          {count}
          {#if memory.isSaved}
            <span aria-hidden="true"> · </span><Icon icon={mdiHeart} size="12" aria-hidden="true" />
            {$t('favorite')}
          {/if}
        </small>
      </span>
      <span class="fm-card-play" aria-hidden="true"><Icon icon={mdiPlay} size="20" /></span>
    </a>
    <div class="fm-card-menu">
      <Menu label={$t('frameleaf_memories_more_actions', { values: { title: headline.title } })} align="end">
        {#snippet trigger()}<Icon icon={mdiDotsVertical} size="18" aria-hidden="true" />{/snippet}
        <MenuItem onSelect={() => play(memory)}>
          <Icon icon={mdiPlay} size="16" aria-hidden="true" />
          {$t('frameleaf_memories_play')}
        </MenuItem>
        <MenuItem onSelect={() => void toggleFavorite(memory)}>
          <Icon icon={memory.isSaved ? mdiHeart : mdiHeartOutline} size="16" aria-hidden="true" />
          {memory.isSaved ? $t('frameleaf_memories_remove_from_favorites') : $t('favorite')}
        </MenuItem>
        <hr class="fm-menu-separator" />
        {#each showLessOptions(memory, { t: $t, locale: $locale }) as option (option.rule.kind + option.rule.value)}
          <MenuItem onSelect={() => void showLess(option.rule)}>
            <Icon icon={mdiMinusCircleOutline} size="16" aria-hidden="true" />
            {option.label}
          </MenuItem>
        {/each}
        <MenuItem onSelect={() => void hide(memory)}>
          <Icon icon={mdiEyeOffOutline} size="16" aria-hidden="true" />
          {$t('frameleaf_memories_hide')}
        </MenuItem>
      </Menu>
    </div>
  </article>
{/snippet}

<div class="fm">
  <header class="fm-header">
    <div>
      <h1>{$t('memories')}</h1>
      <p>{$t('frameleaf_memories_subtitle_day', { values: { day: longToday } })}</p>
    </div>
    <div class="fm-popover-wrap" use:clickOutside={{ onOutclick: () => closeSettings(false) }}>
      <button
        bind:this={gear}
        type="button"
        class="fm-icon-button"
        class:active={settingsOpen}
        aria-label={$t('frameleaf_memories_settings')}
        title={$t('frameleaf_memories_settings')}
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        aria-controls={settingsOpen ? 'fm-settings' : undefined}
        onclick={() => (settingsOpen = !settingsOpen)}
      >
        <Icon icon={mdiCogOutline} size="18" aria-hidden="true" />
      </button>
      {#if settingsOpen}
        <div
          id="fm-settings"
          class="fm-popover"
          role="dialog"
          tabindex="-1"
          aria-label={$t('frameleaf_memories_settings')}
          onkeydown={(event) => {
            if (event.key !== 'Escape') {
              return;
            }
            event.stopPropagation();
            closeSettings(true);
          }}
          {@attach focusFirst}
        >
          <strong>{$t('frameleaf_memories_settings')}</strong>
          <button
            type="button"
            role="switch"
            aria-checked={preferences.showUpcoming}
            class="fm-switch"
            class:on={preferences.showUpcoming}
            onclick={() => void applySetting({ showUpcoming: !preferences.showUpcoming })}
          >
            <span class="fm-switch-track" aria-hidden="true"></span>
            <span>
              {$t('frameleaf_memories_show_upcoming')}
              <small>{$t('frameleaf_memories_show_upcoming_description')}</small>
            </span>
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={preferences.onlyFavorites}
            class="fm-switch"
            class:on={preferences.onlyFavorites}
            onclick={() => void applySetting({ onlyFavorites: !preferences.onlyFavorites })}
          >
            <span class="fm-switch-track" aria-hidden="true"></span>
            <span>
              {$t('only_favorites')}
              <small>{$t('frameleaf_memories_only_favorites_description')}</small>
            </span>
          </button>
          {#if memoryManager.showLess.length > 0}
            <div class="fm-show-less">
              <small>{$t('frameleaf_memories_show_less_heading')}</small>
              <ul>
                {#each memoryManager.showLess as rule (rule.kind + rule.value)}
                  <li>
                    <span>{ruleLabel(rule)}</span>
                    <IconButton
                      label={$t('frameleaf_memories_show_less_remove', { values: { label: ruleLabel(rule) } })}
                      onclick={() => void showAgain(rule)}
                    >
                      <Icon icon={mdiRestore} size="16" />
                    </IconButton>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </header>

  <Status message={status} />

  <section class="fm-section" aria-label={$t('frameleaf_memories_today')}>
    <div class="fm-section-heading">
      <h2>{$t('frameleaf_memories_today')}</h2>
      {#if sections.today.length > 0}
        <small>{$t('frameleaf_memories_subtitle', { values: { count: sections.today.length } })}</small>
      {/if}
    </div>
    {#if sections.today.length > 0}
      <div class="fm-hero">
        {#each sections.today as entry, position (entry.memory.id)}
          {@render card(entry, position === 0 ? 'hero' : 'regular')}
        {/each}
      </div>
    {:else if memoryManager.loading && nothing}
      <div class="fm-loading"><LoadingSpinner size="giant" /></div>
    {:else}
      <div class="fm-quiet">
        {#if quietCover}
          <img
            src={getAssetMediaUrl({ id: quietCover.id, size: AssetMediaSize.Preview })}
            alt=""
            loading="lazy"
            draggable="false"
          />
        {/if}
        <span class="fm-shade" aria-hidden="true"></span>
        <span class="fm-card-copy">
          <span class="fm-overline">
            <Icon icon={mdiCalendarTodayOutline} size="14" aria-hidden="true" />
            {longToday}
          </span>
          <strong>{$t('frameleaf_memories_nothing_today')}</strong>
          <small>
            {#if nextUp}
              {$t('frameleaf_memories_next_arrives', {
                values: { count: nextUp.inDays ?? 1, subtitle: $memoryHeadline(nextUp.memory).subtitle },
              })}
            {:else if preferences.onlyFavorites}
              {$t('frameleaf_memories_quiet_favorites')}
            {:else}
              {$t('frameleaf_memories_quiet_description')}
            {/if}
          </small>
        </span>
      </div>
    {/if}
  </section>

  {#if preferences.showUpcoming && sections.upcoming.length > 0}
    <section class="fm-section" aria-label={$t('memories_upcoming')}>
      <div class="fm-section-heading">
        <h2>{$t('memories_upcoming')}</h2>
        <small>{$t('frameleaf_memories_next_14_days')}</small>
      </div>
      <div class="fm-row">
        {#each sections.upcoming as entry (entry.memory.id)}
          {@render card(entry, 'regular')}
        {/each}
      </div>
    </section>
  {/if}

  <section class="fm-section" aria-label={$t('frameleaf_memories_earlier')}>
    <div class="fm-section-heading">
      <h2>{$t('frameleaf_memories_earlier')}</h2>
      {#if sections.earlier.length > 0}
        <small>{$t('frameleaf_memories_earlier_caption')}</small>
      {/if}
    </div>
    {#if sections.earlier.length > 0}
      <div class="fm-grid">
        {#each sections.earlier as entry (entry.memory.id)}
          {@render card(entry, 'regular')}
        {/each}
      </div>
    {:else if !memoryManager.loading}
      <div class="fm-empty" role="status">
        <Icon icon={mdiHistory} size="30" aria-hidden="true" />
        <strong>{nothing ? $t('frameleaf_memories_empty_title') : $t('frameleaf_memories_nothing_earlier')}</strong>
        <p>
          {preferences.onlyFavorites
            ? $t('frameleaf_memories_empty_favorites')
            : $t('frameleaf_memories_empty_description')}
        </p>
      </div>
    {/if}
  </section>

  {#if memoryManager.hidden.length > 0}
    <section class="fm-section fm-hidden" aria-label={$t('frameleaf_memories_hidden')}>
      <div class="fm-section-heading">
        <h2>{$t('frameleaf_memories_hidden')}</h2>
        <button type="button" class="fm-link" aria-expanded={showHidden} onclick={() => (showHidden = !showHidden)}>
          {showHidden
            ? $t('frameleaf_memories_hide_list')
            : $t('frameleaf_memories_show_hidden', { values: { count: memoryManager.hidden.length } })}
          <Icon icon={showHidden ? mdiChevronUp : mdiChevronDown} size="16" aria-hidden="true" />
        </button>
      </div>
      {#if showHidden}
        <ul class="fm-hidden-list">
          {#each memoryManager.hidden as memory (memory.id)}
            {@const headline = $memoryHeadline(memory)}
            <li>
              {@render coverImage(memory, false)}
              <span>
                <strong>{headline.title}</strong>
                <small>{headline.subtitle}</small>
              </span>
              <Button onclick={() => void restore(memory)}>
                <Icon icon={mdiRestore} size="16" aria-hidden="true" />
                {$t('restore')}
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .fm {
    display: flex;
    flex-direction: column;
    color: var(--fl-text);
  }
  /* discovery.css:56-75 */
  .fm-header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-block-end: 1.5rem;
  }
  .fm-header h1 {
    font-size: 1.25rem;
  }
  .fm-header p {
    margin: 0.5rem 0 0;
    color: var(--fl-muted);
    font-size: 0.8125rem;
    line-height: 1.6;
  }
  .fm-icon-button {
    display: inline-grid;
    place-items: center;
    width: 2.125rem;
    height: 2.125rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .fm-icon-button.active {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  /* discovery.css:284-352 */
  .fm-popover-wrap {
    position: relative;
  }
  .fm-popover {
    position: absolute;
    inset-inline-end: 0;
    top: calc(100% + 0.5rem);
    z-index: 20;
    width: min(18.75rem, calc(100vw - 2rem));
    padding: 0.875rem 1rem 0.75rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
  }
  .fm-popover > strong {
    display: block;
    margin-block-end: 0.5rem;
  }
  .fm-switch {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    width: 100%;
    min-height: 2.5rem;
    padding: 0.5rem 0;
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    text-align: start;
    background: none;
    border: 0;
  }
  .fm-switch > span:last-child {
    display: flex;
    flex-direction: column;
    gap: 0.1875rem;
    min-width: 0;
  }
  .fm-switch small {
    color: var(--fl-muted);
    line-height: 1.4;
  }
  .fm-switch-track {
    position: relative;
    flex-shrink: 0;
    width: 2rem;
    height: 1.125rem;
    margin-block-start: 1px;
    background: var(--fl-border);
    border-radius: 0.75rem;
    transition: background var(--fl-motion) var(--fl-ease);
  }
  .fm-switch-track::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 0.75rem;
    height: 0.75rem;
    background: var(--fl-text);
    border-radius: 50%;
    transition: transform var(--fl-motion) var(--fl-ease);
  }
  .fm-switch.on .fm-switch-track {
    background: var(--fl-accent);
  }
  .fm-switch.on .fm-switch-track::after {
    background: var(--fl-accent-text);
    transform: translateX(0.875rem);
  }
  .fm-show-less {
    margin-block-start: 0.5rem;
    padding-block-start: 0.5rem;
    border-block-start: 1px solid var(--fl-border);
  }
  .fm-show-less small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fm-show-less ul {
    display: flex;
    flex-direction: column;
    margin: 0.25rem 0 0;
    padding: 0;
    list-style: none;
  }
  .fm-show-less li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: var(--fl-font-small);
  }
  /* discovery.css:117-145 */
  .fm-section {
    min-width: 0;
    margin: 0 0 1.75rem;
  }
  .fm-section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-block-end: 0.875rem;
  }
  .fm-section-heading h2 {
    font-size: 1rem;
  }
  .fm-section-heading > small {
    flex: 1;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fm-link {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 1.875rem;
    padding: 0.3125rem 0 0.3125rem 0.5rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    background: none;
    border: 0;
  }
  .fm-link:hover {
    color: var(--fl-text);
  }
  /* discovery.css:887-1003 */
  .fm-hero {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) repeat(auto-fit, minmax(12.5rem, 1fr));
    gap: 0.875rem;
  }
  .fm-row {
    display: grid;
    grid-auto-columns: minmax(13.75rem, 1fr);
    grid-auto-flow: column;
    gap: 0.75rem;
    overflow-x: auto;
    padding-block-end: 0.375rem;
  }
  .fm-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14.375rem, 1fr));
    gap: 0.875rem;
  }
  @media (max-width: 40rem) {
    .fm-hero {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  /* Overflow stays visible on the card (unlike .fm-card-main) so its menu is never clipped. */
  .fm-card {
    position: relative;
    min-height: 15rem;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .fm-card.hero {
    min-height: 20rem;
  }
  .fm-card-main {
    position: absolute;
    inset: 0;
    display: block;
    overflow: hidden;
    color: #fff;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .fm-card-main > :global(.fm-cover),
  .fm-quiet > img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  /* memories.css:107-109: the engine sets --kb-* only when motion is allowed. */
  .fm-card-main:is(:hover, :focus-visible) > :global(.fm-cover[style*='--kb-from']) {
    animation: fl-ken-burns var(--kb-duration, 9s) ease-in-out infinite alternate;
  }
  @media (prefers-reduced-motion: reduce) {
    .fm-card-main:is(:hover, :focus-visible) > :global(.fm-cover) {
      animation: none;
      transform: none;
    }
  }
  :global(.fm-cover-empty) {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    min-height: 3.875rem;
    color: var(--fl-muted);
    background: var(--fl-raised);
  }
  .fm-shade {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(180deg, transparent 30%, rgb(0 0 0 / 74%));
  }
  .fm-card-copy {
    position: absolute;
    inset-inline: 1.125rem;
    inset-block-end: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .fm-card.hero .fm-card-copy,
  .fm-quiet .fm-card-copy {
    inset-inline: 1.5rem;
    inset-block-end: 1.375rem;
  }
  .fm-overline {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-block-end: 0.25rem;
    color: #e3e7e5;
    font-size: var(--fl-font-micro);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .fm-card-copy strong {
    font-size: 1.0625rem;
    letter-spacing: -0.015em;
    line-height: 1.25;
  }
  .fm-card.hero .fm-card-copy strong {
    font-size: 1.5rem;
  }
  .fm-card-copy small {
    color: #e3e7e5;
    font-size: var(--fl-font-small);
  }
  .fm-card-count {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .fm-card-play {
    position: absolute;
    inset-inline-end: 1rem;
    inset-block-end: 1rem;
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    background: rgb(255 255 255 / 16%);
    border-radius: 50%;
    opacity: 0;
    transform: translateY(4px);
    transition:
      opacity var(--fl-motion) var(--fl-ease),
      transform var(--fl-motion) var(--fl-ease);
  }
  @supports (backdrop-filter: blur(6px)) {
    .fm-card-play {
      backdrop-filter: blur(6px);
    }
  }
  .fm-card-main:is(:hover, :focus-visible) .fm-card-play {
    opacity: 1;
    transform: none;
  }
  .fm-card-menu {
    position: absolute;
    inset-inline-end: 0.5rem;
    inset-block-start: 0.5rem;
  }
  .fm-card-menu :global(button[aria-haspopup]) {
    color: #fff;
    background: rgb(0 0 0 / 55%);
    border-color: transparent;
  }
  .fm-card-menu :global(.fm-menu-separator) {
    margin: 0.25rem 0;
    border: 0;
    border-block-start: 1px solid var(--fl-border);
  }
  .fm-quiet {
    position: relative;
    min-height: 13.75rem;
    overflow: hidden;
    color: #fff;
    background: var(--fl-panel);
    border-radius: var(--fl-radius-card);
  }
  .fm-quiet > img {
    filter: saturate(0.6) brightness(0.8);
  }
  .fm-quiet .fm-card-copy {
    max-width: 60ch;
  }
  .fm-quiet strong {
    font-size: 1.375rem;
    letter-spacing: -0.02em;
  }
  .fm-quiet small {
    line-height: 1.5;
  }
  .fm-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3rem 0;
  }
  /* discovery.css:173-190 */
  .fm-empty {
    padding: 3.125rem 0.75rem;
    color: var(--fl-muted);
    text-align: center;
  }
  .fm-empty strong {
    display: block;
    margin-block-start: 0.875rem;
    color: var(--fl-text);
    font-size: 0.9375rem;
  }
  .fm-empty p {
    max-width: 42ch;
    margin: 0.5rem auto 0;
    font-size: 0.8125rem;
    line-height: 1.55;
  }
  /* discovery.css:1037-1070 */
  .fm-hidden .fm-section-heading h2 {
    color: var(--fl-muted);
  }
  .fm-hidden-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .fm-hidden-list li {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
    background: var(--fl-panel);
    border-radius: var(--fl-radius-card);
  }
  .fm-hidden-list li > :global(:is(.fm-cover, .fm-cover-empty)) {
    flex-shrink: 0;
    width: 3.5rem;
    height: 3.5rem;
    min-height: 0;
    object-fit: cover;
    border-radius: var(--fl-radius-control);
  }
  .fm-hidden-list li > span {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.1875rem;
    min-width: 0;
  }
  .fm-hidden-list small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
