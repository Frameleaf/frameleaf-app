<script lang="ts">
  /**
   * Ask about your photos (FL-31, owner decision recorded on FL-146): the /search page's empty state.
   *
   * Built from the September 24 search palette (`SearchPalette.jsx`, `search-palette.css` at
   * effd05ffb7), which draws no separate Ask screen: the same frosted glass panel with the large field
   * and magnifier, the Clear button, the live "Searching…" / "N matches" status, "Try a search" rows
   * moved with the arrow keys, and the "No matches in your library." line. The question goes to the
   * real natural-language search (POST /search/ask, which answers through smart search or metadata
   * search), under the server's `localFeatures.askSearch` settings: when an administrator turns Ask off
   * the panel says so instead of offering a field that cannot answer, and the answer count never
   * passes the server's "Most answers shown" limit. The reading of the question is AI content, so it
   * carries the indigo sparkle when smart search answered it.
   *
   * Keyboard: the field is a combobox over the examples. ArrowDown and ArrowUp move through them,
   * Enter asks the highlighted example or the typed question, Escape leaves the list and then clears
   * the field.
   */
  import { SEARCH_ASK_EXAMPLES, type SearchAskProblem } from '$lib/frameleaf/search-ask';
  import { Icon } from '@immich/ui';
  import type { AskSearchResponseDto } from '@immich/sdk';
  import { mdiAlertCircleOutline, mdiClose, mdiCreation, mdiHistory, mdiMagnify } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    query = $bindable(''),
    response,
    loading = false,
    problem,
    matches = 0,
    onAsk,
    onRetry,
  }: {
    query?: string;
    /** The answer to the question asked last, if it has arrived. */
    response?: AskSearchResponseDto;
    loading?: boolean;
    problem?: SearchAskProblem;
    /** How many answers have been loaded. */
    matches?: number;
    onAsk: (query: string) => void;
    onRetry?: () => void;
  } = $props();

  const listId = $props.id();
  let input: HTMLInputElement | undefined = $state();
  let active = $state(-1);
  const disabled = $derived(problem === 'disabled');
  const optionId = (index: number) => `${listId}-example-${index}`;

  const ask = (text: string) => {
    const question = text.trim();
    if (!question || loading || disabled) {
      return;
    }
    query = question;
    active = -1;
    onAsk(question);
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.isComposing) {
      return;
    }
    const count = SEARCH_ASK_EXAMPLES.length;
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        active = (active + 1) % count;
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        active = active <= 0 ? count - 1 : active - 1;
        break;
      }
      case 'Escape': {
        if (active >= 0) {
          event.preventDefault();
          active = -1;
        } else if (query) {
          event.preventDefault();
          query = '';
        }
        break;
      }
      case 'Enter': {
        event.preventDefault();
        ask(active >= 0 ? SEARCH_ASK_EXAMPLES[active] : query);
        break;
      }
    }
  };

  const clear = () => {
    query = '';
    active = -1;
    input?.focus();
  };
</script>

<section class="frameleaf sa" aria-labelledby="{listId}-title">
  <h2 id="{listId}-title" class="sr-only">{$t('frameleaf_search_ask_title')}</h2>
  <div class="sa-panel fl-continuous-corners" role="search">
    <div class="sa-field">
      <Icon icon={mdiMagnify} size="22" aria-hidden="true" />
      <input
        bind:this={input}
        bind:value={query}
        type="text"
        role="combobox"
        aria-label={$t('frameleaf_search_ask_title')}
        aria-expanded={!disabled}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        aria-busy={loading}
        autocomplete="off"
        spellcheck="false"
        placeholder={$t('frameleaf_search_ask_placeholder')}
        {disabled}
        onkeydown={onKeydown}
        oninput={() => (active = -1)}
      />
      {#if query && !disabled}
        <button type="button" class="sa-icon-button" aria-label={$t('frameleaf_search_ask_clear')} onclick={clear}>
          <Icon icon={mdiClose} size="16" aria-hidden="true" />
        </button>
      {/if}
      <span class="sa-status" aria-live="polite">
        {#if loading}
          {$t('searching')}
        {:else if response}
          {$t('frameleaf_search_ask_matches', { values: { count: matches } })}
        {/if}
      </span>
    </div>

    <div class="sa-body">
      {#if problem === 'disabled'}
        <p class="sa-note" role="status">
          <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden="true" />
          {$t('frameleaf_search_ask_disabled')}
        </p>
      {:else if problem === 'failed'}
        <p class="sa-note sa-error" role="alert">
          <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden="true" />
          <span>{$t('frameleaf_search_ask_failed')}</span>
          {#if onRetry}
            <button type="button" class="sa-link" onclick={onRetry}>{$t('frameleaf_search_ask_retry')}</button>
          {/if}
        </p>
      {:else if response}
        <section class="sa-answer" aria-label={$t('frameleaf_search_ask_reading')}>
          <h3>
            {$t('frameleaf_search_ask_reading')}
            {#if response.plan.mode === 'smart'}
              <span class="sa-ai" title={$t('frameleaf_search_ask_ai')}>
                <Icon icon={mdiCreation} size="12" aria-hidden="true" />
                <span class="sr-only">{$t('frameleaf_search_ask_ai')}</span>
              </span>
            {/if}
          </h3>
          <p>{response.explanation}</p>
          {#each response.warnings as warning (warning)}
            <p class="sa-warning">{warning}</p>
          {/each}
          {#if !loading && matches === 0}
            <p class="sa-empty">{$t('frameleaf_search_ask_no_matches')}</p>
          {/if}
        </section>
      {/if}

      {#if !disabled}
        <section class="sa-examples">
          <h3 id="{listId}-examples">{$t('frameleaf_search_ask_try')}</h3>
          <div id={listId} role="listbox" aria-labelledby="{listId}-examples">
            {#each SEARCH_ASK_EXAMPLES as example, index (example)}
              <!-- Options are chosen from the field (combobox); a pointer can pick one directly. -->
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                id={optionId(index)}
                role="option"
                tabindex="-1"
                aria-selected={index === active}
                aria-disabled={loading}
                class="sa-row"
                class:active={index === active}
                onclick={() => ask(example)}
              >
                <Icon icon={mdiHistory} size="16" aria-hidden="true" />
                <span>{example}</span>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    </div>
  </div>
</section>

<style>
  /* search-palette.css (effd05ffb7): the palette's glass panel, field, rows and status. */
  .sa {
    --sa-row: color-mix(in srgb, var(--fl-text) 8%, transparent);
    --sa-active: color-mix(in srgb, var(--fl-accent) 22%, transparent);
    display: flex;
    justify-content: center;
    width: 100%;
    color: var(--fl-text);
  }
  .sa-panel {
    width: min(980px, 100%);
    overflow: hidden;
    font-size: 13px;
    background: var(--fl-material);
    border: 1px solid var(--fl-material-edge);
    border-radius: 20px;
    box-shadow: var(--fl-shadow-2);
    backdrop-filter: var(--fl-material-blur);
  }
  @supports (corner-shape: squircle) {
    .sa-panel {
      border-radius: 36px;
    }
  }
  .sa-field {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 14px 12px 18px;
    color: var(--fl-muted);
    border-bottom: 1px solid var(--fl-material-edge);
  }
  .sa-field input {
    flex: 1;
    min-width: 0;
    padding: 6px 0;
    color: var(--fl-text);
    font: 400 21px/1.2 inherit;
    letter-spacing: -0.01em;
    background: transparent;
    border: 0;
    border-radius: 0;
    outline: 0;
    box-shadow: none;
  }
  .sa-field input:disabled {
    opacity: 0.6;
  }
  .sa-panel:focus-within {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .sa-icon-button {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    color: inherit;
    background: transparent;
    border: 0;
    border-radius: 999px;
  }
  .sa-icon-button:hover {
    background: var(--sa-row);
  }
  .sa-status {
    margin-inline-start: auto;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .sa-body {
    display: grid;
    gap: 18px;
    padding: 14px 18px;
  }
  .sa h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 6px;
    color: var(--fl-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .sa-answer p {
    margin: 0;
    line-height: 1.5;
  }
  .sa-warning {
    color: var(--fl-muted);
  }
  /* The indigo sparkle is reserved for AI content (tokens.css --fl-ai). */
  .sa-ai {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    color: var(--fl-ai-text);
    background: var(--fl-ai);
    border-radius: 6px;
  }
  .sa-empty,
  .sa-note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0;
    color: var(--fl-muted);
  }
  .sa-empty {
    margin-block-start: 8px;
  }
  .sa-error {
    color: var(--fl-text);
  }
  .sa-link {
    color: var(--fl-accent);
    font-size: 12px;
    font-weight: 500;
    background: transparent;
    border: 0;
  }
  .sa-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding: 6px 10px;
    border-radius: 8px;
    cursor: pointer;
  }
  .sa-row > span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sa-row:hover {
    background: var(--sa-row);
  }
  .sa-row.active {
    background: var(--sa-active);
  }
  .sa-row[aria-disabled='true'] {
    cursor: default;
    opacity: 0.6;
  }
</style>
