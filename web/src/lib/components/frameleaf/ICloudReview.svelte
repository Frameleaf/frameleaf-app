<script lang="ts">
  /**
   * iCloud review: every photo a sync could not settle by itself, with its reason. Accept one in the large view, a
   * whole page, or all of them. Hidden iCloud photos never wait here; they import to Locked. Nothing here deletes.
   */
  import { goto } from '$app/navigation';
  import { page as appPage } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { icloudErrorKey, icloudReviewReasonKey } from '$lib/frameleaf/icloud-sync';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    ICloudReviewEffect,
    ICloudReviewGroup,
    ICloudReviewKind,
    acceptICloudReview,
    getICloudReview,
    type ICloudReviewAcceptDto,
    type ICloudReviewPageResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiArrowLeft,
    mdiCheck,
    mdiCheckCircleOutline,
    mdiChevronLeft,
    mdiChevronRight,
    mdiClockOutline,
    mdiClose,
    mdiImageOffOutline,
    mdiLockOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { t, type Translations } from 'svelte-i18n';

  type Item = ICloudReviewPageResponseDto['items'][number];

  let { connectionId, onBack }: { connectionId: string; onBack: () => void } = $props();

  const PAGE_SIZE = 48;
  const GROUP_KEYS: Record<ICloudReviewGroup, Translations> = {
    [ICloudReviewGroup.Match]: 'frameleaf_icloud_review_group_match',
    [ICloudReviewGroup.LivePhoto]: 'frameleaf_icloud_review_group_live_photo',
    [ICloudReviewGroup.Stack]: 'frameleaf_icloud_review_group_stack',
    [ICloudReviewGroup.Details]: 'frameleaf_icloud_review_group_details',
    [ICloudReviewGroup.Edits]: 'frameleaf_icloud_review_group_edits',
    [ICloudReviewGroup.Storage]: 'frameleaf_icloud_review_group_storage',
    [ICloudReviewGroup.Other]: 'frameleaf_icloud_review_group_other',
  };
  const EFFECT_KEYS: Record<ICloudReviewEffect, Translations> = {
    [ICloudReviewEffect.UseExisting]: 'frameleaf_icloud_review_effect_use_existing',
    [ICloudReviewEffect.KeepCurrent]: 'frameleaf_icloud_review_effect_keep_current',
    [ICloudReviewEffect.TryAgain]: 'frameleaf_icloud_review_effect_try_again',
  };

  let review = $state<ICloudReviewPageResponseDto>();
  let group = $state<ICloudReviewGroup | undefined>();
  let current = $state(1);
  /** Photos held back from Accept, across pages. */
  let later = $state<Record<string, Item>>({});
  let openId = $state<string | null>(null);
  let confirmAll = $state(false);
  let busy = $state(false);
  let said = $state('');
  let error = $state('');
  let request = 0;

  const items = $derived(review?.items ?? []);
  const openIndex = $derived(items.findIndex(({ resourceId }) => resourceId === openId));
  const open = $derived(openIndex === -1 ? undefined : items[openIndex]);
  const laterInView = $derived(Object.values(later).filter((item) => !group || item.group === group));
  const pageToAccept = $derived(items.filter(({ resourceId }) => !Object.hasOwn(later, resourceId)));
  const allToAccept = $derived(Math.max(0, (review?.total ?? 0) - laterInView.length));
  const totalWaiting = $derived(review?.groups.reduce((sum, { count }) => sum + count, 0) ?? 0);
  const allEffects = $derived.by(() => {
    const effects = { ...(review?.effects ?? { useExisting: 0, keepCurrent: 0, tryAgain: 0 }) };
    for (const { effect } of laterInView) {
      if (effect === ICloudReviewEffect.UseExisting) {
        effects.useExisting--;
      } else if (effect === ICloudReviewEffect.TryAgain) {
        effects.tryAgain--;
      } else {
        effects.keepCurrent--;
      }
    }
    return effects;
  });
  const number = (value: number) => value.toLocaleString($locale);

  const load = async (nextPage = current) => {
    const mine = ++request;
    try {
      const loaded = await getICloudReview({ id: connectionId, group, page: nextPage, size: PAGE_SIZE });
      if (mine === request) {
        review = loaded;
        current = loaded.page;
        error = '';
      }
      return loaded;
    } catch (error_) {
      if (mine === request) {
        error = $t(icloudErrorKey(getServerErrorMessage(error_)));
      }
    }
  };

  onMount(() => void load(1));

  const choose = (next: ICloudReviewGroup | undefined) => {
    group = next;
    void load(1);
  };

  const toggleLater = (item: Item, hold = !Object.hasOwn(later, item.resourceId)) => {
    const next = { ...later };
    if (hold) {
      next[item.resourceId] = item;
    } else {
      delete next[item.resourceId];
    }
    later = next;
  };

  const accept = async (selection: ICloudReviewAcceptDto, expected: number) => {
    if (busy || expected === 0) {
      return false;
    }
    busy = true;
    error = '';
    try {
      const { accepted } = await acceptICloudReview({ id: connectionId, iCloudReviewAcceptDto: selection });
      said =
        accepted < expected
          ? $t('frameleaf_icloud_review_accepted_some', { values: { count: accepted, busy: expected - accepted } })
          : $t('frameleaf_icloud_review_accepted', { values: { count: accepted } });
      const loaded = await load();
      // A reason whose last photo was just accepted falls back to All.
      if (group && !loaded?.groups.some((entry) => entry.group === group)) {
        group = undefined;
        await load(1);
      }
      return true;
    } catch (error_) {
      error = $t(icloudErrorKey(getServerErrorMessage(error_)));
      return false;
    } finally {
      busy = false;
    }
  };

  const acceptPage = () =>
    accept({ resourceIds: pageToAccept.map(({ resourceId }) => resourceId) }, pageToAccept.length);

  const acceptEverything = async () => {
    confirmAll = false;
    const except = laterInView.map(({ resourceId }) => resourceId);
    await accept({ all: true, group, ...(except.length > 0 && { exceptResourceIds: except }) }, allToAccept);
  };

  const step = async (by: 1 | -1) => {
    const next = items[openIndex + by];
    if (next) {
      openId = next.resourceId;
      return;
    }
    const target = current + by;
    if (review && target >= 1 && target <= review.pages) {
      const loaded = await load(target);
      const entry = by === 1 ? loaded?.items[0] : loaded?.items.at(-1);
      openId = entry?.resourceId ?? null;
    }
  };

  const acceptOpen = async () => {
    if (!open) {
      return;
    }
    const index = openIndex;
    if (await accept({ resourceIds: [open.resourceId] }, 1)) {
      openId = items[Math.min(index, items.length - 1)]?.resourceId ?? null;
    }
  };

  const leaveOpen = () => {
    if (open) {
      toggleLater(open, true);
      void step(1);
    }
  };

  const onkeydown = (event: KeyboardEvent) => {
    if (!open || confirmAll || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const actions: Record<string, () => void> = {
      Escape: () => (openId = null),
      ArrowRight: () => void step(1),
      ArrowLeft: () => void step(-1),
      a: () => void acceptOpen(),
      l: leaveOpen,
    };
    const action = actions[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  };

  const hasPrevious = $derived(openIndex > 0 || current > 1);
  const hasNext = $derived(openIndex < items.length - 1 || current < (review?.pages ?? 1));
  const takenOn = (value: string | null) => {
    const date = value ? new Date(value) : undefined;
    return date && !Number.isNaN(date.getTime())
      ? date.toLocaleDateString($locale, { day: 'numeric', month: 'short', year: 'numeric' })
      : '';
  };
</script>

<svelte:window {onkeydown} />

<div class="icr">
  <div class="icr-head">
    <Button onclick={onBack}>
      <Icon icon={mdiArrowLeft} size="18" />
      {$t('frameleaf_icloud_review_back')}
    </Button>
    <div>
      <h2>{$t('frameleaf_icloud_review_title')}</h2>
      <p>{$t('frameleaf_icloud_review_lead')}</p>
    </div>
  </div>

  {#if review && review.hiddenLocked > 0}
    <p class="icr-note">
      <Icon icon={mdiLockOutline} size="20" />
      <span>{$t('frameleaf_icloud_review_hidden_locked', { values: { count: review.hiddenLocked } })}</span>
    </p>
  {/if}
  {#if review && review.privateWaiting > 0}
    <div class="icr-note">
      <Icon icon={mdiLockOutline} size="20" />
      <span>{$t('frameleaf_icloud_review_private', { values: { count: review.privateWaiting } })}</span>
      <Button onclick={() => void goto(Route.pinPrompt({ continue: appPage.url.pathname + appPage.url.search }))}>
        {$t('unlock')}
      </Button>
    </div>
  {/if}
  {#if said}
    <p class="icr-said" role="status"><Icon icon={mdiCheckCircleOutline} size="18" /> {said}</p>
  {/if}
  {#if error}
    <p class="icr-error" role="alert">{error}</p>
  {/if}

  {#if !review}
    {#if !error}<p class="icr-loading" role="status">{$t('loading')}</p>{/if}
  {:else if totalWaiting === 0}
    <div class="icr-empty">
      <Icon icon={mdiCheckCircleOutline} size="36" />
      <h3>{$t('frameleaf_icloud_review_empty_title')}</h3>
      <p>{$t('frameleaf_icloud_review_empty')}</p>
      <Button onclick={onBack}>{$t('frameleaf_icloud_review_back')}</Button>
    </div>
  {:else}
    <div class="icr-filters" role="group" aria-label={$t('frameleaf_icloud_review_reasons')}>
      <button type="button" class:on={!group} aria-pressed={!group} onclick={() => choose(undefined)}>
        {$t('all')} <span>{number(totalWaiting)}</span>
      </button>
      {#each review.groups as entry (entry.group)}
        <button
          type="button"
          class:on={group === entry.group}
          aria-pressed={group === entry.group}
          onclick={() => choose(entry.group)}
        >
          {$t(GROUP_KEYS[entry.group])} <span>{number(entry.count)}</span>
        </button>
      {/each}
    </div>

    <ul class="icr-grid">
      {#each items as item (item.resourceId)}
        {@const held = Object.hasOwn(later, item.resourceId)}
        <li class:later={held}>
          <button
            type="button"
            class="icr-photo"
            aria-label={`${item.fileName ?? $t('frameleaf_icloud_untitled')}: ${$t(GROUP_KEYS[item.group])}`}
            onclick={() => (openId = item.resourceId)}
          >
            {#if item.previewAssetId}
              <img
                src={getAssetMediaUrl({ id: item.previewAssetId, size: AssetMediaSize.Thumbnail })}
                alt=""
                loading="lazy"
              />
            {:else}
              <span class="icr-none"><Icon icon={mdiImageOffOutline} size="28" /></span>
            {/if}
            <span class="icr-tag">{$t(GROUP_KEYS[item.group])}</span>
          </button>
          <button
            type="button"
            class="icr-choice"
            aria-pressed={!held}
            aria-label={$t(held ? 'frameleaf_icloud_review_include' : 'frameleaf_icloud_review_hold', {
              values: { name: item.fileName ?? $t('frameleaf_icloud_untitled') },
            })}
            onclick={() => toggleLater(item)}
          >
            <Icon icon={held ? mdiClockOutline : mdiCheck} size="16" />
            {held ? $t('frameleaf_icloud_review_later') : $t('frameleaf_icloud_review_accept')}
          </button>
        </li>
      {/each}
    </ul>

    <div class="icr-bar" role="region" aria-label={$t('frameleaf_icloud_review_accept')}>
      <nav aria-label={$t('frameleaf_icloud_review_pages')}>
        <button
          type="button"
          class="icr-page"
          aria-label={$t('previous')}
          disabled={current <= 1}
          onclick={() => void load(current - 1)}
        >
          <Icon icon={mdiChevronLeft} size="22" />
        </button>
        <span>
          {$t('frameleaf_icloud_review_page', { values: { page: current, pages: review.pages } })}
          <small>
            {$t('frameleaf_icloud_review_range', {
              values: {
                from: number((current - 1) * review.size + 1),
                to: number((current - 1) * review.size + items.length),
                total: number(review.total),
              },
            })}
          </small>
        </span>
        <button
          type="button"
          class="icr-page"
          aria-label={$t('next')}
          disabled={current >= review.pages}
          onclick={() => void load(current + 1)}
        >
          <Icon icon={mdiChevronRight} size="22" />
        </button>
      </nav>
      <div>
        <Button disabled={busy || pageToAccept.length === 0} onclick={() => void acceptPage()}>
          {$t('frameleaf_icloud_review_accept_page', { values: { count: pageToAccept.length } })}
        </Button>
        <Button variant="primary" disabled={busy || allToAccept === 0} onclick={() => (confirmAll = true)}>
          {$t('frameleaf_icloud_review_accept_all', { values: { count: allToAccept } })}
        </Button>
      </div>
    </div>
  {/if}
</div>

{#if open}
  <div class="icr-viewer" role="dialog" aria-modal="true" aria-label={open.fileName ?? $t('frameleaf_icloud_untitled')}>
    <div class="icr-stage">
      <header>
        <span>
          {$t('frameleaf_icloud_review_position', {
            values: {
              position: number((current - 1) * (review?.size ?? PAGE_SIZE) + openIndex + 1),
              total: number(review?.total ?? 0),
            },
          })}
        </span>
        <button type="button" class="icr-round" aria-label={$t('close')} onclick={() => (openId = null)}>
          <Icon icon={mdiClose} size="22" />
        </button>
      </header>
      <div class="icr-frame">
        <button
          type="button"
          class="icr-round"
          aria-label={$t('previous')}
          disabled={!hasPrevious}
          onclick={() => void step(-1)}
        >
          <Icon icon={mdiChevronLeft} size="28" />
        </button>
        <figure>
          {#if open.previewAssetId}
            <img
              src={getAssetMediaUrl({ id: open.previewAssetId, size: AssetMediaSize.Preview })}
              alt={open.fileName ?? ''}
            />
          {:else}
            <div class="icr-none large">
              <Icon icon={mdiImageOffOutline} size="48" />
              <p>{$t('frameleaf_icloud_review_no_preview')}</p>
            </div>
          {/if}
        </figure>
        <button
          type="button"
          class="icr-round"
          aria-label={$t('next')}
          disabled={!hasNext}
          onclick={() => void step(1)}
        >
          <Icon icon={mdiChevronRight} size="28" />
        </button>
      </div>
    </div>
    <aside>
      <div class="icr-side">
        <p class="icr-overline">{$t('frameleaf_icloud_review_why')}</p>
        <h3>{$t(GROUP_KEYS[open.group])}</h3>
        <p>{$t(icloudReviewReasonKey({ kind: ICloudReviewKind.Review, reason: open.reason }))}</p>
        <p class="icr-overline">{$t('frameleaf_icloud_review_if_accept')}</p>
        <p>{$t(EFFECT_KEYS[open.effect])}</p>
        <dl>
          <div>
            <dt>{$t('frameleaf_icloud_review_file')}</dt>
            <dd>{open.fileName ?? $t('frameleaf_icloud_untitled')}</dd>
          </div>
          {#if takenOn(open.takenAt)}
            <div>
              <dt>{$t('frameleaf_icloud_review_taken')}</dt>
              <dd>{takenOn(open.takenAt)}</dd>
            </div>
          {/if}
        </dl>
      </div>
      <div class="icr-actions">
        <Button onclick={leaveOpen}>{$t('frameleaf_icloud_review_later')} <kbd>L</kbd></Button>
        <Button variant="primary" disabled={busy} onclick={() => void acceptOpen()}>
          {$t('frameleaf_icloud_review_accept')} <kbd>A</kbd>
        </Button>
      </div>
    </aside>
  </div>
{/if}

<Dialog
  title={$t('frameleaf_icloud_review_confirm_title', { values: { count: allToAccept } })}
  closeLabel={$t('cancel')}
  bind:open={confirmAll}
>
  <ul class="icr-summary">
    {#if allEffects.useExisting > 0}
      <li><strong>{number(allEffects.useExisting)}</strong> {$t('frameleaf_icloud_review_done_use_existing')}</li>
    {/if}
    {#if allEffects.keepCurrent > 0}
      <li><strong>{number(allEffects.keepCurrent)}</strong> {$t('frameleaf_icloud_review_done_keep_current')}</li>
    {/if}
    {#if allEffects.tryAgain > 0}
      <li><strong>{number(allEffects.tryAgain)}</strong> {$t('frameleaf_icloud_review_done_try_again')}</li>
    {/if}
  </ul>
  <p class="icr-dialog-note">
    {$t('frameleaf_icloud_review_nothing_deleted')}
    {#if laterInView.length > 0}{$t('frameleaf_icloud_review_later_stays')}{/if}
  </p>
  <div class="icr-dialog-actions">
    <Button onclick={() => (confirmAll = false)}>{$t('cancel')}</Button>
    <Button variant="primary" disabled={busy} onclick={() => void acceptEverything()}>
      {$t('frameleaf_icloud_review_confirm', { values: { count: allToAccept } })}
    </Button>
  </div>
</Dialog>

<style>
  .icr-head {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: center;
    margin-bottom: 24px;
  }
  .icr-head h2 {
    margin: 0 0 4px;
    font-size: var(--fl-font-xl);
  }
  .icr-head p,
  .icr-loading {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-md);
  }
  .icr-note {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    margin: 0 0 20px;
    padding: 14px 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    font-size: var(--fl-font-md);
  }
  .icr-note span {
    flex: 1 1 200px;
  }
  .icr-said,
  .icr-error {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 0 0 20px;
    font-size: var(--fl-font-md);
  }
  .icr-error {
    color: var(--fl-danger);
  }
  .icr-empty {
    display: grid;
    gap: 8px;
    justify-items: center;
    padding: 56px 24px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    text-align: center;
  }
  .icr-empty h3,
  .icr-empty p {
    margin: 0;
  }
  .icr-empty p {
    margin-bottom: 8px;
    color: var(--fl-muted);
  }
  .icr-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 24px;
  }
  .icr-filters button {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    min-height: 36px;
    padding: 0 14px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-md);
    cursor: pointer;
  }
  .icr-filters span {
    color: var(--fl-muted);
  }
  .icr-filters button.on {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
  }
  .icr-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 16px;
    margin: 0 0 16px;
    padding: 0;
    list-style: none;
  }
  .icr-grid li {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  .icr-photo {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 1;
    padding: 0;
    overflow: hidden;
    border: 0;
    border-radius: var(--fl-radius-lg);
    background: var(--fl-raised);
    color: var(--fl-muted);
    cursor: zoom-in;
  }
  .icr-photo:focus-visible {
    outline: 3px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .icr-photo img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .icr-none {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
  }
  .icr-none.large {
    gap: 8px;
    min-height: 240px;
    color: rgb(255 255 255 / 0.72);
  }
  .icr-none p {
    margin: 0;
  }
  .icr-tag {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    padding: 20px 8px 8px;
    background: linear-gradient(transparent, rgb(0 0 0 / 0.72));
    color: #fff;
    font-size: var(--fl-font-xs);
    font-weight: var(--fl-weight-medium);
    text-align: left;
  }
  .later .icr-photo {
    opacity: 0.45;
  }
  .icr-choice {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    justify-content: center;
    min-height: 36px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-sm);
    cursor: pointer;
  }
  .icr-choice[aria-pressed='true'] {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
  }
  .icr-bar {
    position: sticky;
    bottom: 16px;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-2);
  }
  .icr-bar nav,
  .icr-bar > div {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .icr-bar nav span {
    display: grid;
    min-width: 132px;
    font-size: var(--fl-font-md);
    text-align: center;
  }
  .icr-bar small {
    color: var(--fl-muted);
    font-size: var(--fl-font-xs);
  }
  .icr-page {
    display: grid;
    flex: none;
    place-items: center;
    width: 40px;
    height: 40px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    cursor: pointer;
  }
  .icr-page:disabled,
  .icr-round:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .icr-summary {
    display: grid;
    gap: 10px;
    margin: 0 0 16px;
    padding: 0;
    list-style: none;
    font-size: var(--fl-font-md);
  }
  .icr-summary strong {
    display: inline-block;
    min-width: 48px;
    margin-right: 8px;
    text-align: right;
  }
  .icr-dialog-note {
    margin: 0 0 20px;
    color: var(--fl-muted);
    font-size: var(--fl-font-md);
  }
  .icr-dialog-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    justify-content: flex-end;
  }
  .icr-viewer {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    background: rgb(8 8 9);
    color: #fff;
  }
  .icr-stage {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    padding: 16px 24px 24px;
  }
  .icr-stage header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    color: rgb(255 255 255 / 0.72);
    font-size: var(--fl-font-md);
  }
  .icr-frame {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 16px;
    align-items: center;
    min-height: 0;
  }
  .icr-frame figure {
    display: grid;
    place-items: center;
    height: 100%;
    min-height: 0;
    margin: 0;
  }
  .icr-frame img {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 112px);
    object-fit: contain;
    border-radius: var(--fl-radius-lg);
  }
  .icr-round {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 0;
    border-radius: 50%;
    background: rgb(255 255 255 / 0.12);
    color: #fff;
    cursor: pointer;
  }
  .icr-viewer aside {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    min-height: 0;
    border-left: 1px solid rgb(255 255 255 / 0.14);
    background: rgb(24 24 27);
  }
  .icr-side {
    padding: 24px;
    overflow-y: auto;
    font-size: var(--fl-font-md);
  }
  .icr-side h3 {
    margin: 0 0 8px;
    font-size: var(--fl-font-xl);
  }
  .icr-side p {
    margin: 0 0 24px;
    color: rgb(255 255 255 / 0.82);
  }
  .icr-side .icr-overline {
    margin-bottom: 8px;
    color: rgb(255 255 255 / 0.6);
    font-size: var(--fl-font-xs);
    font-weight: var(--fl-weight-medium);
  }
  .icr-side dl {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
    margin: 0;
    padding-top: 16px;
    border-top: 1px solid rgb(255 255 255 / 0.14);
  }
  .icr-side dl div {
    display: flex;
    gap: 16px;
    justify-content: space-between;
  }
  .icr-side dt {
    color: rgb(255 255 255 / 0.6);
  }
  .icr-side dd {
    margin: 0;
    overflow-wrap: anywhere;
    text-align: right;
  }
  .icr-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 16px 24px;
    border-top: 1px solid rgb(255 255 255 / 0.14);
  }
  .icr-actions kbd {
    margin-left: 6px;
    padding: 0 6px;
    border: 1px solid currentColor;
    border-radius: 4px;
    font: inherit;
    font-size: var(--fl-font-xs);
    opacity: 0.7;
  }

  @media (max-width: 800px) {
    .icr-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .icr-tag {
      display: none;
    }
    .icr-choice {
      font-size: var(--fl-font-xs);
    }
    .icr-bar,
    .icr-bar nav,
    .icr-bar > div {
      width: 100%;
    }
    .icr-bar nav {
      justify-content: space-between;
    }
    .icr-bar > div > :global(*) {
      flex: 1 1 0;
      min-width: 0;
    }
    .icr-viewer {
      grid-template-rows: minmax(0, 1fr) minmax(0, 46vh);
      grid-template-columns: minmax(0, 1fr);
    }
    .icr-stage {
      padding: 12px 16px;
    }
    .icr-frame {
      position: relative;
      grid-template-columns: minmax(0, 1fr);
    }
    .icr-frame > .icr-round {
      position: absolute;
      top: 50%;
      z-index: 1;
      background: rgb(0 0 0 / 0.55);
      transform: translateY(-50%);
    }
    .icr-frame > .icr-round:first-child {
      left: 8px;
    }
    .icr-frame > .icr-round:last-child {
      right: 8px;
    }
    .icr-frame img {
      max-height: calc(54vh - 84px);
    }
    .icr-viewer aside {
      border-top: 1px solid rgb(255 255 255 / 0.14);
      border-left: 0;
    }
    .icr-side {
      padding: 16px;
    }
    .icr-side p {
      margin-bottom: 16px;
    }
    .icr-actions {
      padding: 12px 16px;
    }
    .icr-actions kbd {
      display: none;
    }
  }
</style>
