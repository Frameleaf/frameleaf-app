<script lang="ts">
  /**
   * The list Account activity and the household Activity log share (FL-824, after the approved
   * prototype's `ActivityList` in `settings-v2/cloud/AccountActivity.jsx`): newest first, one group
   * per day, with the All / Sign-ins / Security / Sharing / Apps chips, each row a sentence with the
   * time and one more line where there is something to add. Rows follow Change history
   * (`SettingsChangeHistory`), so the two lists read alike.
   *
   * The chips filter the rows already loaded (owner, 2026-11-12: no server filter). The next page
   * loads by itself as the end of the list comes into view, so a chip with few rows keeps filling.
   * That stops after a few pages in a row that add nothing to what the chip shows, so a chip with
   * nothing under it never reads the whole log; "Show earlier activity" goes on by hand.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import {
    ACTIVITY_AUTO_PAGES,
    ACTIVITY_CHIPS,
    ACTIVITY_KEPT_DAYS,
    activityDay,
    activityTime,
    describeActivity,
    filterActivity,
    groupByDay,
    pictureOf,
    type ActivityChip,
    type ActivityEvent,
    type ActivityRow,
  } from '$lib/frameleaf/account-activity';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import type { UserAdminResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { untrack, type Snippet } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type RowAction = { text: string; label: string; chevron?: boolean; onclick: () => void };
  type Props = {
    title: string;
    description: string;
    /** Every row loaded so far, newest first; null while the first page loads. */
    events: ActivityEvent[] | null;
    /** The household log: everyone with an account, so each row names who it is about and shows a picture. */
    people?: Map<string, UserAdminResponseDto>;
    /** Whether the server holds earlier rows than the ones loaded. */
    hasMore: boolean;
    loadingMore?: boolean;
    moreFailed?: boolean;
    onMore: () => void;
    /** Beside the chips: the household log's "Whose" filter. */
    filter?: Snippet;
    /** The button at the end of a row, when it has one. */
    rowAction?: (event: ActivityEvent, row: ActivityRow) => RowAction | undefined;
    /** The moment "today" is measured from (for tests). */
    now?: Date;
  };

  let {
    title,
    description,
    events,
    people,
    hasMore,
    loadingMore = false,
    moreFailed = false,
    onMore,
    filter,
    rowAction,
    now = new Date(),
  }: Props = $props();

  let chip = $state<ActivityChip>('all');

  const bytes = (value: number) => getByteUnitString(value, $locale);
  const nameOf = (id: string) => people?.get(id)?.name ?? $t('frameleaf_account_activity_log_someone');
  const rowOf = (event: ActivityEvent) =>
    describeActivity($t, event, { name: people ? nameOf(event.userId) : undefined, formatBytes: bytes });

  const shown = $derived(filterActivity(events ?? [], chip));
  const days = $derived(groupByDay(shown, (createdAt) => activityDay($t, createdAt, now, $locale)));

  // The next page loads as the end of the list comes into view. A page that failed waits to be asked.
  // Pages that load by themselves and add nothing to what the chip shows are counted: after a few in
  // a row, loading waits to be asked, until the chip changes or a row arrives.
  let end = $state<HTMLElement>();
  let paused = $state(false);
  let idle = 0;
  let seen = -1;
  $effect(() => {
    void chip;
    idle = 0;
    seen = -1;
  });
  $effect(() => {
    void chip;
    void shown.length;
    paused = false;
  });
  const loadBySelf = () => {
    const count = untrack(() => shown.length);
    idle = count === seen ? idle + 1 : 0;
    seen = count;
    if (idle >= ACTIVITY_AUTO_PAGES) {
      paused = true;
      return;
    }
    onMore();
  };
  $effect(() => {
    const element = end;
    if (!element || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadBySelf();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  });
</script>

{#snippet bones(label: string, rows: number)}
  <ul class="list loading" aria-busy="true" aria-label={label}>
    {#each Array.from({ length: rows }, (_, index) => index) as row (row)}
      <li class="row">
        <span class="tile"></span>
        <div class="main">
          <span class="bone"></span>
          <span class="bone is-short"></span>
        </div>
      </li>
    {/each}
  </ul>
{/snippet}

<Section {title} {description}>
  <div class="bar">
    <div class="chips" role="group" aria-label={$t('frameleaf_account_activity_chips_label')}>
      {#each ACTIVITY_CHIPS as id (id)}
        <button type="button" aria-pressed={chip === id} onclick={() => (chip = id)}>
          {$t(`frameleaf_account_activity_chip_${id}` as Translations)}
        </button>
      {/each}
    </div>
    {@render filter?.()}
  </div>

  {#if events === null}
    {@render bones($t('frameleaf_account_activity_loading'), 5)}
  {:else if days.length === 0}
    <div class="none">
      <strong>
        {chip === 'all'
          ? $t('frameleaf_account_activity_hero_empty_title')
          : $t(`frameleaf_account_activity_none_${chip}` as Translations)}
      </strong>
      <p>
        {hasMore ? $t('frameleaf_account_activity_none_further') : $t('frameleaf_account_activity_none_nothing')}
        {#if chip !== 'all'}
          <TextLink onclick={() => (chip = 'all')}>{$t('frameleaf_account_activity_show_all')}</TextLink>
        {/if}
      </p>
    </div>
  {:else}
    {#each days as group (group.day)}
      <div class="day">
        <h3>{group.day}</h3>
        <ul class="list">
          {#each group.events as event (event.id)}
            {@const row = rowOf(event)}
            {@const person = people?.get(pictureOf(event))}
            {@const action = rowAction?.(event, row)}
            <li class="row" data-action={event.action}>
              {#if person}
                <!-- Whoever did it, else who the row is about, with their name as the tooltip. -->
                <span class="face" title={person.name}><UserAvatar user={person} noTitle /></span>
              {:else}
                <span class="tile" class:is-warn={row.warn} aria-hidden="true"><Icon icon={row.icon} size="22" /></span>
              {/if}
              <div class="main">
                <strong>{row.text}</strong>
                <span>
                  <time datetime={event.createdAt}>{activityTime(event.createdAt, $locale)}</time
                  >{#if row.note}{` · ${row.note}`}{/if}
                </span>
              </div>
              {#if row.warn}
                <span class="pill">
                  <Pill tone="warn">
                    {row.warn === 'cut-off'
                      ? $t('frameleaf_account_activity_pill_cut_off')
                      : $t('frameleaf_account_activity_pill_didnt_get_in')}
                  </Pill>
                </span>
              {/if}
              {#if action}
                <span class="act">
                  <Button label={action.label} onclick={action.onclick}
                    >{action.text}{#if action.chevron}<Icon
                        icon={mdiChevronRight}
                        size="1em"
                        aria-hidden
                      />{/if}</Button
                  >
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  {/if}

  {#if events !== null && (days.length > 0 || hasMore)}
    <div class="more" aria-live="polite">
      {#if loadingMore}
        {@render bones($t('frameleaf_account_activity_getting_more'), 2)}
      {:else if hasMore}
        {#if moreFailed}
          <p role="alert">{$t('frameleaf_account_activity_more_failed')}</p>
          <Button onclick={onMore}>{$t('frameleaf_account_activity_try_again')}</Button>
        {:else}
          {#if !paused}<span class="end" bind:this={end}></span>{/if}
          <Button onclick={onMore}>{$t('frameleaf_account_activity_show_earlier')}</Button>
        {/if}
      {:else}
        <p>{$t('frameleaf_account_activity_end', { values: { days: ACTIVITY_KEPT_DAYS } })}</p>
      {/if}
    </div>
  {/if}
</Section>

<style>
  /* The chips, and in the household log the person filter. */
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3) var(--fl-space-6);
    padding-bottom: var(--fl-space-2);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .chips button {
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-4);
    color: var(--fl-muted);
    font: inherit;
    font-size: var(--fl-font-callout);
    background: transparent;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    cursor: pointer;
  }
  .chips button:hover {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .chips button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .chips button[aria-pressed='true'] {
    color: var(--fl-text);
    font-weight: 600;
    background: color-mix(in srgb, var(--fl-accent) 13%, transparent);
    border-color: color-mix(in srgb, var(--fl-accent) 45%, var(--fl-border));
  }

  /* One day. */
  .day h3 {
    margin: 0;
    padding: var(--fl-space-6) 0 var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--fl-space-4);
    min-height: 76px;
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
  .tile,
  .face {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
  }
  .tile {
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .tile.is-warn {
    color: var(--fl-warning);
    background: color-mix(in srgb, var(--fl-warning) 14%, transparent);
  }
  .face {
    overflow: hidden;
    border-radius: 50%;
  }
  .main > strong {
    display: block;
    font-size: var(--fl-font-size);
    font-weight: 600;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .main > span {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }
  .pill {
    grid-column: 3;
  }
  .act {
    grid-column: 4;
  }

  /* The end of the list: more to get, getting it, or nothing more. */
  .more {
    position: relative;
    display: grid;
    justify-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-6) 0;
    border-top: 1px solid var(--fl-border);
  }
  .more > p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
    text-align: center;
  }
  .end {
    position: absolute;
    top: 0;
    width: 1px;
    height: 1px;
  }

  /* A chip with nothing under it. */
  .none {
    display: grid;
    justify-items: center;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-4);
    padding: var(--fl-space-10) var(--fl-space-4) var(--fl-space-12);
    border-top: 1px solid var(--fl-border);
    text-align: center;
  }
  .none strong {
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .none p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }

  /* Loading: rows the size of the real ones. */
  .loading {
    margin-top: var(--fl-space-4);
  }
  .loading .row {
    grid-template-columns: 44px minmax(0, 1fr);
  }
  .more > .loading {
    justify-self: stretch;
    margin: calc(-1 * var(--fl-space-6)) 0;
  }
  .more > .loading .row:first-child {
    border-top: 0;
  }
  .loading .tile,
  .bone {
    background: var(--fl-raised);
    animation: activity-pulse 1.4s ease-in-out infinite;
  }
  .main > .bone {
    width: min(360px, 80%);
    height: 14px;
    margin-top: 0;
    border-radius: var(--fl-radius-control);
  }
  .main > .bone.is-short {
    width: min(180px, 45%);
    height: 12px;
    margin-top: 10px;
  }
  @keyframes activity-pulse {
    50% {
      opacity: 0.45;
    }
  }

  @container kit (max-width: 620px) {
    .row {
      grid-template-columns: 44px minmax(0, 1fr);
      align-items: start;
      gap: var(--fl-space-3) var(--fl-space-4);
    }
    .pill,
    .act {
      grid-column: 2;
      justify-self: start;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .loading .tile,
    .bone {
      animation: none;
    }
  }
</style>
