<script lang="ts">
  /**
   * iCloud review: every photo a sync could not settle by itself. Open one to compare the iCloud copy with your
   * library, see why it waits and what Accept and Later do; accept one, a whole page, or all of them. Hidden iCloud
   * photos never wait here (they import to Locked), and nothing here replaces or deletes. Owner-approved mock:
   * prototype PR 95.
   */
  import { goto } from '$app/navigation';
  import { page as appPage } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import LightViewer from '$lib/components/frameleaf/LightViewer.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import GridSkeleton from '$lib/components/frameleaf/GridSkeleton.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { formatDateTime } from '$lib/frameleaf/date-format';
  import { icloudErrorKey } from '$lib/frameleaf/icloud-sync';
  import { formatCount } from '$lib/frameleaf/number-format';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    ICloudReviewDifferenceField,
    ICloudReviewEffect,
    ICloudReviewGroup,
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
    mdiImageOutline,
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
  /** One plain sentence on why a photo waits, and what accepting it does. Possible match no longer waits here. */
  const REASON_KEYS: Record<ICloudReviewGroup, { why: Translations; accept: Translations }> = {
    [ICloudReviewGroup.Match]: {
      why: 'frameleaf_icloud_review_why_other',
      accept: 'frameleaf_icloud_review_accept_other',
    },
    [ICloudReviewGroup.LivePhoto]: {
      why: 'frameleaf_icloud_review_why_live_photo',
      accept: 'frameleaf_icloud_review_accept_live_photo',
    },
    [ICloudReviewGroup.Stack]: {
      why: 'frameleaf_icloud_review_why_stack',
      accept: 'frameleaf_icloud_review_accept_stack',
    },
    [ICloudReviewGroup.Details]: {
      why: 'frameleaf_icloud_review_why_details',
      accept: 'frameleaf_icloud_review_accept_details',
    },
    [ICloudReviewGroup.Edits]: {
      why: 'frameleaf_icloud_review_why_edits',
      accept: 'frameleaf_icloud_review_accept_edits',
    },
    [ICloudReviewGroup.Storage]: {
      why: 'frameleaf_icloud_review_why_storage',
      accept: 'frameleaf_icloud_review_accept_storage',
    },
    [ICloudReviewGroup.Other]: {
      why: 'frameleaf_icloud_review_why_other',
      accept: 'frameleaf_icloud_review_accept_other',
    },
  };
  const DIFFERENCE_KEYS: Record<ICloudReviewDifferenceField, Translations> = {
    [ICloudReviewDifferenceField.DateTaken]: 'frameleaf_icloud_review_diff_date_taken',
    [ICloudReviewDifferenceField.Favorite]: 'favorite',
    [ICloudReviewDifferenceField.LiveVideo]: 'frameleaf_icloud_review_diff_video',
    [ICloudReviewDifferenceField.Edits]: 'frameleaf_icloud_review_group_edits',
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
      if (effect === ICloudReviewEffect.TryAgain) {
        effects.tryAgain--;
      } else {
        effects.keepCurrent--;
      }
    }
    return effects;
  });
  const number = (value: number) => formatCount(value, $locale);

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
      ? formatDateTime(
          date,
          {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          },
          $locale,
        )
      : '';
  };
  type Difference = Item['differences'][number];
  const shown = (difference: Difference, value: string | null) => {
    if (value === null) {
      return '—';
    }
    switch (difference.field) {
      case ICloudReviewDifferenceField.DateTaken: {
        return takenOn(value);
      }
      case ICloudReviewDifferenceField.Favorite: {
        return $t(value === 'true' ? 'yes' : 'no');
      }
      case ICloudReviewDifferenceField.Edits: {
        return number(Number(value));
      }
      default: {
        return value;
      }
    }
  };
  const thumb = (id: string, size = AssetMediaSize.Thumbnail) => getAssetMediaUrl({ id, size });
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
  {#if error && review}
    <p class="icr-error" role="alert">{error}</p>
  {/if}

  {#if !review}
    <!-- FL-1810: placeholders in the shape of the grid, and a failed read says so in place -->
    {#if error}
      <InlineError compact message={error} onRetry={() => load(1)} />
    {:else}
      <GridSkeleton tiles={8} />
    {/if}
  {:else if totalWaiting === 0}
    <EmptyState
      icon={mdiCheckCircleOutline}
      title={$t('frameleaf_icloud_review_empty_title')}
      message={$t('frameleaf_icloud_review_empty')}
      secondaryAction={{ label: $t('frameleaf_icloud_review_back'), onClick: onBack }}
    />
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

    <div class="icr-explain">
      {#if group}
        <p>{$t(REASON_KEYS[group].why)}</p>
        <p><strong>{$t('frameleaf_icloud_review_accept_label')}</strong> {$t(REASON_KEYS[group].accept)}</p>
      {:else}
        <p>{$t('frameleaf_icloud_review_explain_all')}</p>
        <p>
          <strong>{$t('frameleaf_icloud_review_accept_label')}</strong>
          {$t('frameleaf_icloud_review_explain_accept')}
        </p>
      {/if}
      <p><strong>{$t('frameleaf_icloud_review_later_label')}</strong> {$t('frameleaf_icloud_review_later_effect')}</p>
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
            {#if item.icloudAssetId ?? item.previewAssetId}
              <img src={thumb((item.icloudAssetId ?? item.previewAssetId)!)} alt="" loading="lazy" />
            {:else}
              <span class="icr-blank"><Icon icon={mdiImageOutline} size="28" /></span>
            {/if}
            <!-- The tile is the iCloud copy with the library copy in the corner; with no iCloud copy here yet, the
              library photo fills the tile instead of a blank. -->
            {#if item.icloudAssetId && item.previewAssetId}
              <img class="icr-inset" src={thumb(item.previewAssetId)} alt="" loading="lazy" />
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
  <LightViewer
    label={open.fileName ?? $t('frameleaf_icloud_untitled')}
    position={$t('frameleaf_icloud_review_position', {
      values: {
        position: number((current - 1) * (review?.size ?? PAGE_SIZE) + openIndex + 1),
        total: number(review?.total ?? 0),
      },
    })}
    {hasPrevious}
    {hasNext}
    onPrevious={() => void step(-1)}
    onNext={() => void step(1)}
    onClose={() => (openId = null)}
  >
    <div class="icr-sides">
      <figure>
        <figcaption>{$t('frameleaf_icloud_review_in_icloud')}</figcaption>
        {#if open.icloudAssetId}
          <div class="icr-shot">
            <img src={thumb(open.icloudAssetId, AssetMediaSize.Preview)} alt={open.fileName ?? ''} />
          </div>
        {:else}
          <div class="icr-shot icr-none">
            <Icon icon={mdiImageOutline} size="32" />
            <span>{$t('frameleaf_icloud_review_icloud_none')}</span>
          </div>
        {/if}
      </figure>
      <figure>
        <figcaption>{$t('frameleaf_icloud_review_in_library')}</figcaption>
        {#if open.previewAssetId}
          <div class="icr-shot" class:is-group={open.relatedAssetIds.length > 0}>
            <img src={thumb(open.previewAssetId, AssetMediaSize.Preview)} alt={open.fileName ?? ''} />
            {#if open.relatedAssetIds.length > 0}
              <div class="icr-with">
                <small>
                  {$t(
                    open.group === ICloudReviewGroup.Edits
                      ? 'frameleaf_icloud_review_with_edits'
                      : 'frameleaf_icloud_review_with_stack',
                  )}
                </small>
                {#each open.relatedAssetIds as id (id)}
                  <img src={thumb(id)} alt="" />
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          <div class="icr-shot icr-none">
            <Icon icon={mdiImageOutline} size="32" />
            <span>{$t('frameleaf_icloud_review_library_none')}</span>
          </div>
        {/if}
      </figure>
    </div>
    {#snippet aside()}
      <div class="icr-side">
        <p class="icr-overline">{$t('frameleaf_icloud_review_why')}</p>
        <h3>{$t(GROUP_KEYS[open.group])}</h3>
        <p>{$t(REASON_KEYS[open.group].why)}</p>
        {#if open.differences.length > 0}
          <table class="icr-diff">
            <thead>
              <tr>
                <td></td>
                <th scope="col">{$t('frameleaf_icloud_review_in_icloud')}</th>
                <th scope="col">{$t('frameleaf_icloud_review_in_library')}</th>
              </tr>
            </thead>
            <tbody>
              {#each open.differences as difference (difference.field)}
                <tr>
                  <th scope="row">{$t(DIFFERENCE_KEYS[difference.field])}</th>
                  <td>{shown(difference, difference.icloud)}</td>
                  <td>{shown(difference, difference.library)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
        <p class="icr-overline">{$t('frameleaf_icloud_review_if_accept')}</p>
        <p>{$t(REASON_KEYS[open.group].accept)}</p>
        <p class="icr-overline">{$t('frameleaf_icloud_review_if_later')}</p>
        <p>{$t('frameleaf_icloud_review_later_effect')}</p>
        <dl>
          <div>
            <dt>{$t('frameleaf_icloud_review_file')}</dt>
            <dd>{open.fileName ?? $t('frameleaf_icloud_untitled')}</dd>
          </div>
          {#if open.camera}
            <div>
              <dt>{$t('camera')}</dt>
              <dd>{open.camera}</dd>
            </div>
          {/if}
          {#if open.fileSize !== null}
            <div>
              <dt>{$t('size')}</dt>
              <dd>{getByteUnitString(open.fileSize, $locale)}</dd>
            </div>
          {/if}
          {#if takenOn(open.takenAt)}
            <div>
              <dt>{$t('frameleaf_icloud_review_taken')}</dt>
              <dd>{takenOn(open.takenAt)}</dd>
            </div>
          {/if}
        </dl>
      </div>
      <div class="icr-actions">
        <Button onclick={leaveOpen}>
          {Object.hasOwn(later, open.resourceId)
            ? $t('frameleaf_icloud_review_marked_later')
            : $t('frameleaf_icloud_review_later')}
          <kbd>L</kbd>
        </Button>
        <Button variant="primary" disabled={busy} onclick={() => void acceptOpen()}>
          {$t('frameleaf_icloud_review_accept')} <kbd>A</kbd>
        </Button>
      </div>
    {/snippet}
  </LightViewer>
{/if}

<Dialog
  title={$t('frameleaf_icloud_review_confirm_title', { values: { count: allToAccept } })}
  closeLabel={$t('cancel')}
  bind:open={confirmAll}
>
  <ul class="icr-summary">
    {#if allEffects.keepCurrent > 0}
      <li>
        <strong>{number(allEffects.keepCurrent)}</strong>
        {$t('frameleaf_icloud_review_done_keep_current', { values: { count: allEffects.keepCurrent } })}
      </li>
    {/if}
    {#if allEffects.tryAgain > 0}
      <li>
        <strong>{number(allEffects.tryAgain)}</strong>
        {$t('frameleaf_icloud_review_done_try_again', { values: { count: allEffects.tryAgain } })}
      </li>
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
  .icr-explain {
    display: grid;
    gap: 4px;
    margin: 0 0 20px;
    padding: 14px 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    font-size: var(--fl-font-md);
  }
  .icr-explain p {
    margin: 0;
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
  .icr-blank {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
  }
  .icr-photo .icr-inset {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 44px;
    height: 44px;
    border: 2px solid #fff;
    border-radius: var(--fl-radius-md);
    box-shadow: var(--fl-shadow-2);
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
    text-align: start;
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
  .icr-page:disabled {
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
    margin-inline-end: 8px;
    text-align: end;
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
  .icr-sides {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 16px;
    align-items: start;
    min-height: 0;
  }
  .icr-sides figure {
    display: grid;
    gap: 8px;
    min-width: 0;
    margin: 0;
  }
  .icr-sides figcaption {
    color: var(--fl-muted);
    font-size: var(--fl-font-md);
    font-weight: var(--fl-weight-medium);
  }
  .icr-shot {
    display: grid;
    place-items: center;
    min-height: 0;
    padding: 12px;
    border-radius: var(--fl-radius-lg);
    background: var(--fl-raised);
  }
  .icr-shot img {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 148px);
    object-fit: contain;
    border-radius: var(--fl-radius-md);
  }
  /* a group: the photo itself large, the photos it sits with small beneath */
  .icr-shot.is-group {
    gap: 12px;
  }
  .icr-shot.is-group > img {
    max-height: calc(100vh - 236px);
  }
  .icr-with {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    color: var(--fl-muted);
    font-size: var(--fl-font-sm);
  }
  .icr-with img {
    width: 64px;
    height: 64px;
    object-fit: cover;
    border-radius: var(--fl-radius-md);
  }
  .icr-none {
    aspect-ratio: 3 / 2;
    gap: 8px;
    align-content: center;
    border: 1px dashed var(--fl-border);
    background: none;
    color: var(--fl-muted);
    font-size: var(--fl-font-md);
    text-align: center;
  }
  .icr-diff {
    width: 100%;
    margin-bottom: 24px;
    border-collapse: collapse;
    font-size: var(--fl-font-sm);
  }
  .icr-diff th,
  .icr-diff td {
    padding: 8px;
    border-bottom: 1px solid var(--fl-border);
    text-align: start;
    vertical-align: top;
  }
  .icr-diff th:first-child,
  .icr-diff td:first-child {
    padding-inline-start: 0;
  }
  .icr-diff thead th,
  .icr-diff tbody th {
    color: var(--fl-muted);
    font-weight: var(--fl-weight-medium);
  }
  .icr-diff tbody th {
    font-weight: inherit;
  }
  .icr-diff tbody td {
    font-weight: var(--fl-weight-medium);
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
    color: var(--fl-text);
  }
  .icr-side .icr-overline {
    margin-bottom: 8px;
    color: var(--fl-muted);
    font-size: var(--fl-font-xs);
    font-weight: var(--fl-weight-medium);
  }
  .icr-side dl {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
    margin: 0;
    padding-top: 16px;
    border-top: 1px solid var(--fl-border);
  }
  .icr-side dl div {
    display: flex;
    gap: 16px;
    justify-content: space-between;
  }
  .icr-side dt {
    color: var(--fl-muted);
  }
  .icr-side dd {
    margin: 0;
    overflow-wrap: anywhere;
    text-align: end;
  }
  .icr-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 16px 24px;
    border-top: 1px solid var(--fl-border);
  }
  .icr-actions kbd {
    margin-inline-start: 6px;
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
    .icr-sides {
      gap: 8px;
    }
    .icr-sides figcaption {
      font-size: var(--fl-font-sm);
    }
    .icr-shot {
      padding: 8px;
    }
    .icr-shot img {
      max-height: calc(54vh - 116px);
    }
    .icr-shot.is-group {
      gap: 8px;
    }
    .icr-shot.is-group > img {
      max-height: calc(54vh - 164px);
    }
    .icr-with small {
      display: none;
    }
    .icr-with img {
      width: 40px;
      height: 40px;
    }
    .icr-photo .icr-inset {
      top: 4px;
      right: 4px;
      width: 32px;
      height: 32px;
    }
    .icr-diff {
      margin-bottom: 16px;
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
