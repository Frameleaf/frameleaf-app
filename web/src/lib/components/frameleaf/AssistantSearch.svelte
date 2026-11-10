<script lang="ts">
  /**
   * Library Assistant search beta (FL-918), after the approved prototype `AssistantPanel.jsx` `Search`
   * (FL-799, `/?screen=assistant&view=search`): one field with a Beta label, the
   * Library Assistant / Classic search switch beside it, then where the question was answered, one summary
   * line and the grid, with up to three reasons under every tile ("why this matched").
   *
   * The answer is `POST /assistant/ask` (FL-885). Every reason comes from the item's own stored data or a
   * condition the server checked on it. When the rules answered rather than a planner, the mock's "simple
   * search" line says so; the reasons stay, because the server only states what the data holds.
   * Locked photos never reach the assistant, and the page says so.
   *
   * Keyboard, as `SearchAsk.svelte`: Enter asks, Escape clears the field, Tab moves from the field to Clear,
   * the switch, then the results.
   */
  import AssistantModeSwitch from '$lib/components/frameleaf/AssistantModeSwitch.svelte';
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import {
    ASSISTANT_NAME,
    answeredWithRules,
    reasonsByAsset,
    whyLine,
    whyText,
    type AssistantProblem,
    type WhyReason,
  } from '$lib/frameleaf/assistant';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type AssetResponseDto, type AssistantAskResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiCheckCircleOutline,
    mdiClose,
    mdiCreationOutline,
    mdiImageSearchOutline,
    mdiLockOutline,
    mdiMagnify,
    mdiServerOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  let {
    query = $bindable(''),
    response,
    loading = false,
    problem,
    onAsk,
    onRetry,
    onClassic,
    onOpen,
  }: {
    query?: string;
    /** The answer to the question asked last, once it has arrived. */
    response?: AssistantAskResponseDto;
    loading?: boolean;
    problem?: AssistantProblem;
    onAsk: (query: string) => void;
    onRetry?: () => void;
    /** Switch to classic search, keeping the text. */
    onClassic: () => void;
    onOpen: (asset: AssetResponseDto) => void;
  } = $props();

  const id = $props.id();
  let input: HTMLInputElement | undefined = $state();
  let feedback = $state<'yes' | 'no'>();
  const disabled = $derived(problem === 'disabled');
  const assets = $derived(response?.results.assets.items ?? []);
  const reasons = $derived(reasonsByAsset(response));
  const simple = $derived(answeredWithRules(response));

  const ask = () => {
    const question = query.trim();
    if (!question || loading || disabled) {
      return;
    }
    query = question;
    feedback = undefined;
    onAsk(question);
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.isComposing) {
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      ask();
    } else if (event.key === 'Escape' && query) {
      event.preventDefault();
      query = '';
    }
  };

  const clear = () => {
    query = '';
    input?.focus();
  };

  const reasonText = (reason: WhyReason) => {
    if (reason.kind === 'date') {
      const date = DateTime.fromISO(reason.value, { zone: 'utc' });
      const value = date.isValid
        ? date.toLocaleString({ month: 'short', day: 'numeric', year: 'numeric' }, { locale: $locale })
        : reason.value;
      return $t(reason.key, { values: { value } });
    }
    return $t(reason.key, { values: { value: reason.value } });
  };
</script>

<section class="frameleaf la" aria-labelledby="{id}-title">
  <h2 id="{id}-title" class="sr-only">{ASSISTANT_NAME}</h2>
  <div class="la-ask">
    <label class="la-field" class:is-disabled={disabled}>
      <Icon icon={mdiCreationOutline} size="22" aria-hidden="true" />
      <input
        bind:this={input}
        bind:value={query}
        type="text"
        aria-label={$t('frameleaf_assistant_field')}
        aria-busy={loading}
        autocomplete="off"
        spellcheck="false"
        placeholder={$t('frameleaf_assistant_placeholder')}
        {disabled}
        onkeydown={onKeydown}
      />
      {#if query && !disabled}
        <button type="button" class="la-icon-button" aria-label={$t('frameleaf_search_ask_clear')} onclick={clear}>
          <Icon icon={mdiClose} size="16" aria-hidden="true" />
        </button>
      {/if}
      <Badge value={$t('frameleaf_assistant_beta')} label={$t('frameleaf_assistant_beta')} tone="ai" />
    </label>
    <AssistantModeSwitch classic={false} onChange={onClassic} />
  </div>

  {#if problem === 'disabled'}
    <p class="la-route" role="status">
      <Icon icon={mdiAlertCircleOutline} size="18" aria-hidden="true" />
      {$t('frameleaf_assistant_disabled', { values: { name: ASSISTANT_NAME } })}
    </p>
  {:else if problem === 'failed'}
    <p class="la-route is-warn" role="alert">
      <Icon icon={mdiAlertCircleOutline} size="18" aria-hidden="true" />
      <span>{$t('frameleaf_assistant_failed')}</span>
      {#if onRetry}
        <button type="button" class="la-link" onclick={onRetry}>{$t('frameleaf_search_ask_retry')}</button>
      {/if}
      <button type="button" class="la-link" onclick={onClassic}>{$t('frameleaf_assistant_try_classic')}</button>
    </p>
  {:else if loading}
    <div class="la-thinking" role="status" aria-busy="true">
      <p>
        <span class="la-spinner" aria-hidden="true"></span>
        {$t('frameleaf_assistant_thinking')}
      </p>
      <div class="la-grid" aria-hidden="true">
        {#each [0, 1, 2, 3, 4, 5] as tile (tile)}
          <div class="la-tile">
            <Skeleton variant="tile" aspect="4 / 3" />
            <Skeleton variant="text" width="70%" />
          </div>
        {/each}
      </div>
    </div>
  {:else if response && assets.length === 0}
    <div class="la-empty" role="status">
      <Icon icon={mdiImageSearchOutline} size="34" aria-hidden="true" />
      <h3>{$t('frameleaf_assistant_none_title')}</h3>
      <p>{response.summary}</p>
      {#each response.warnings as warning, index (index)}
        <p>{warning}</p>
      {/each}
      <p>{$t('frameleaf_assistant_none_hint')}</p>
      <button type="button" class="la-button" onclick={onClassic}>{$t('frameleaf_assistant_try_classic')}</button>
    </div>
  {:else if response}
    <p class="la-route" class:is-warn={simple}>
      <Icon icon={simple ? mdiMagnify : mdiServerOutline} size="18" aria-hidden="true" />
      {simple ? $t('frameleaf_assistant_answered_simple') : $t('frameleaf_assistant_answered_server')}
    </p>
    <p class="la-summary" role="status">
      <Icon icon={mdiCheckCircleOutline} size="18" aria-hidden="true" />
      {response.summary}
    </p>
    {#each response.warnings as warning, index (index)}
      <p class="la-route">{warning}</p>
    {/each}
    <ul class="la-grid" aria-label={$t('frameleaf_assistant_results')}>
      {#each assets as asset (asset.id)}
        {@const items = reasons.get(asset.id) ?? []}
        {@const why = whyLine(items)}
        {@const full = whyText(items)}
        <li class="la-tile">
          <button
            type="button"
            class="la-thumb"
            title={full || undefined}
            aria-label={full
              ? $t('frameleaf_assistant_open_why', { values: { name: asset.originalFileName, why: full } })
              : asset.originalFileName}
            onclick={() => onOpen(asset)}
          >
            <img src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
          </button>
          {#if why.length > 0}
            <p class="la-why" title={full}>
              <span class="sr-only">{$t('frameleaf_assistant_why')}</span>
              {#each why as reason (reason.kind)}
                <span>
                  <Icon icon={reason.icon} size="14" aria-hidden="true" />
                  <span class="la-why-text">{reasonText(reason)}</span>
                </span>
              {/each}
            </p>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="la-route">
      <Icon icon={mdiLockOutline} size="18" aria-hidden="true" />
      {$t('frameleaf_assistant_locked')}
    </p>
    <div class="la-feedback">
      {#if feedback === 'yes'}
        <p role="status">{$t('frameleaf_assistant_feedback_thanks')}</p>
      {:else if feedback === 'no'}
        <p role="status">{$t('frameleaf_assistant_feedback_no')}</p>
        <button type="button" class="la-link" onclick={onClassic}>{$t('frameleaf_assistant_try_classic')}</button>
      {:else}
        <span>{$t('frameleaf_assistant_feedback')}</span>
        <button type="button" class="la-button" onclick={() => (feedback = 'yes')}>{$t('yes')}</button>
        <button type="button" class="la-button" onclick={() => (feedback = 'no')}>{$t('no')}</button>
      {/if}
    </div>
  {/if}
</section>

<style>
  /* The prototype's assistant.css (FL-799), on the app's tokens and generous spacing. */
  .la {
    display: grid;
    gap: var(--fl-space-6);
    width: min(1180px, 100%);
    margin-inline: auto;
    color: var(--fl-text);
  }
  .la-ask {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3) var(--fl-space-4);
  }
  .la-field {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    flex: 1 1 420px;
    min-height: 56px;
    padding: 0 18px;
    color: var(--fl-accent);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border-strong, var(--fl-border));
    border-radius: var(--fl-radius-card);
  }
  .la-field:focus-within {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .la-field.is-disabled {
    opacity: 0.6;
  }
  .la-field input {
    flex: 1;
    min-width: 0;
    min-height: 52px;
    padding: 0;
    color: var(--fl-text);
    font: inherit;
    font-size: 19px;
    background: transparent;
    border: 0;
    outline: none;
    box-shadow: none;
  }
  .la-icon-button {
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: 32px;
    color: var(--fl-muted);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-pill);
  }
  .la-icon-button:hover {
    background: color-mix(in srgb, var(--fl-text) 8%, transparent);
  }
  .la-route,
  .la-summary {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--fl-space-3);
    margin: 0;
    line-height: 1.5;
  }
  .la-route {
    color: var(--fl-muted);
    font: var(--fl-type-callout);
  }
  .la-route :global(svg),
  .la-summary :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .la-route.is-warn {
    padding: var(--fl-space-3) var(--fl-space-4);
    color: var(--fl-text);
    background: color-mix(in srgb, var(--fl-warning) 16%, transparent);
    border-radius: var(--fl-radius-control);
  }
  .la-summary {
    font: var(--fl-type-headline);
  }
  .la-summary :global(svg) {
    color: var(--fl-accent);
  }
  .la-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 20px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .la-tile {
    display: grid;
    gap: 10px;
    align-content: start;
    min-width: 0;
  }
  .la-thumb {
    display: block;
    padding: 0;
    overflow: hidden;
    background: var(--fl-raised);
    border: 0;
    border-radius: var(--fl-radius-control);
    cursor: pointer;
  }
  .la-thumb img {
    display: block;
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
  }
  .la-why {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    margin: 0;
    color: var(--fl-muted);
    font: var(--fl-type-callout);
  }
  .la-why > span {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    min-width: 0;
    max-width: 100%;
  }
  .la-why-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .la-thinking p {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    margin: 0 0 var(--fl-space-6);
    color: var(--fl-muted);
  }
  .la-spinner {
    width: 18px;
    height: 18px;
    border: 2px solid var(--fl-border);
    border-top-color: var(--fl-accent);
    border-radius: 50%;
    animation: la-spin 0.9s linear infinite;
  }
  @keyframes la-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .la-spinner {
      animation: none;
    }
  }
  .la-empty {
    display: grid;
    justify-items: center;
    gap: var(--fl-space-3);
    padding: 56px var(--fl-space-6);
    color: var(--fl-muted);
    text-align: center;
    border: 1px dashed var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .la-empty h3,
  .la-empty p {
    margin: 0;
  }
  .la-empty h3 {
    color: var(--fl-text);
    font: var(--fl-type-headline);
  }
  .la-empty p {
    max-width: 520px;
    line-height: 1.55;
  }
  .la-feedback {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2) var(--fl-space-3);
    padding-top: var(--fl-space-3);
    color: var(--fl-muted);
    font: var(--fl-type-callout);
    border-top: 1px solid var(--fl-border);
  }
  .la-feedback p {
    margin: 0;
  }
  .la-button {
    min-height: 36px;
    padding: 0 var(--fl-space-4);
    color: var(--fl-text);
    font: inherit;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    cursor: pointer;
  }
  .la-link {
    padding: 0;
    color: var(--fl-accent);
    font: inherit;
    font-weight: 500;
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  @media (max-width: 640px) {
    .la-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--fl-space-3);
    }
  }
</style>
