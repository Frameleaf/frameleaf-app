<script lang="ts">
  /**
   * The Job manager's "Queue concurrency" dialog (FL-71), the template's `ConcurrencyDialog` in
   * `JobsManager.jsx`: every queue's simultaneous jobs, edited in the one settings draft
   * (`job.<queue>.concurrency`) and saved through the settings review like any other setting. The
   * queues the server keeps at one job are shown as fixed. This is the only place queue concurrency
   * is edited, as in the template.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { isValidConcurrency, JOB_QUEUES, searchTerms, type JobQueueDefinition } from '$lib/frameleaf/job-queues';
  import type { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
  import { Icon } from '@immich/ui';
  import { mdiClockOutline, mdiMagnify } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    open?: boolean;
    store: SystemConfigDraftStore;
    /** True while a configuration file manages the settings. */
    disabled?: boolean;
    title: (definition: JobQueueDefinition) => string;
  };

  let { open = $bindable(false), store, disabled = false, title }: Props = $props();

  type JobConfig = Record<string, { concurrency: number } | undefined>;
  const jobDraft = $derived(store.draft.job as unknown as JobConfig);
  const jobSaved = $derived(store.baseline.job as unknown as JobConfig);

  let search = $state('');
  /** What was typed into a field that is not a valid limit yet; it is not written to the draft. */
  let typed = $state<Record<string, string>>({});

  const isFixed = (definition: JobQueueDefinition) => jobDraft?.[definition.name] === undefined;
  const saved = (definition: JobQueueDefinition) => jobSaved?.[definition.name]?.concurrency ?? 1;
  const current = (definition: JobQueueDefinition) => jobDraft?.[definition.name]?.concurrency ?? 1;
  // A pending draft value stays pending while the field holds text that is not a limit yet: the
  // draft still carries it, so it must not drop out of the count and the review.
  const isPending = (definition: JobQueueDefinition) =>
    !isFixed(definition) && current(definition) !== saved(definition);

  const rows = $derived(
    JOB_QUEUES.filter((definition) => {
      const haystack = `${title(definition)} ${$t(`frameleaf_jobs_category_${definition.category}` as Translations)}`;
      return searchTerms(search).every((term) => haystack.toLowerCase().includes(term));
    }),
  );
  const pending = $derived(JOB_QUEUES.filter((definition) => isPending(definition)).length);
  /** Text that is not a limit is never in the draft, so the review waits until every field is valid. */
  const hasInvalid = $derived(Object.keys(typed).length > 0);

  // Invalid text belongs to this visit; reopening shows the draft again.
  $effect(() => {
    if (!open) {
      typed = {};
    }
  });

  const onInput = (definition: JobQueueDefinition, value: string) => {
    const entry = jobDraft?.[definition.name];
    if (!entry) {
      return;
    }
    if (isValidConcurrency(value)) {
      entry.concurrency = Number(value);
      const { [definition.name]: _, ...rest } = typed;
      typed = rest;
    } else {
      typed = { ...typed, [definition.name]: value };
    }
  };

  const review = () => {
    open = false;
    store.requestReview();
  };
</script>

<Dialog title={$t('frameleaf_jobs_concurrency_title')} closeLabel={$t('close')} wide bind:open>
  <div class="jm-concurrency">
    <p>{$t('frameleaf_jobs_concurrency_help')}</p>
    <div class="jm-message">
      <Icon icon={mdiClockOutline} size="16px" aria-hidden={true} />
      {$t('frameleaf_jobs_concurrency_note')}
    </div>
    <label class="jm-search">
      <Icon icon={mdiMagnify} size="16px" aria-hidden={true} />
      <input
        type="search"
        maxlength="200"
        aria-label={$t('frameleaf_jobs_concurrency_search')}
        placeholder={$t('frameleaf_jobs_search_queues_placeholder')}
        bind:value={search}
      />
    </label>
    <div class="jm-concurrency-list">
      {#each rows as definition (definition.name)}
        {@const fixed = isFixed(definition)}
        {@const invalid = typed[definition.name] !== undefined}
        <label class="jm-concurrency-row">
          <span>
            <strong>{title(definition)}</strong>
            <small>
              {fixed
                ? $t('frameleaf_jobs_concurrency_fixed')
                : $t('frameleaf_jobs_concurrency_saved', {
                    values: {
                      category: $t(`frameleaf_jobs_category_${definition.category}` as Translations),
                      count: saved(definition),
                    },
                  })}
            </small>
          </span>
          <span>
            <input
              aria-label={$t('frameleaf_jobs_concurrency_input', { values: { name: title(definition) } })}
              type="number"
              min="1"
              max="1000"
              step="1"
              disabled={fixed || disabled}
              value={typed[definition.name] ?? current(definition)}
              aria-invalid={invalid}
              oninput={(event) => onInput(definition, event.currentTarget.value)}
            />
            {#if isPending(definition)}
              <small class="jm-pending">{$t('frameleaf_jobs_concurrency_pending_row')}</small>
            {/if}
            {#if invalid}
              <small class="jm-input-error" role="alert">{$t('frameleaf_jobs_concurrency_invalid')}</small>
            {/if}
          </span>
        </label>
      {/each}
    </div>
    <p class="jm-muted">{$t('frameleaf_jobs_concurrency_footer')}</p>
    <footer>
      <Button onclick={() => (open = false)}>{$t('frameleaf_jobs_detail_done')}</Button>
      {#if pending > 0 && !hasInvalid}
        <Button variant="primary" onclick={review}>
          {$t('frameleaf_jobs_concurrency_review', { values: { count: pending } })}
        </Button>
      {/if}
    </footer>
  </div>
</Dialog>

<style>
  /* The template's `jobs-manager.css` concurrency dialog. */
  .jm-concurrency {
    font-size: 13px;
    line-height: 1.6;
    min-width: min(36rem, 100%);
  }
  .jm-concurrency p {
    margin: 0 0 10px;
  }
  .jm-message {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 11px 13px;
    margin: 10px 0;
    border: 1px solid var(--fl-border);
    border-radius: 6px;
    font-size: 12px;
    background: var(--fl-panel);
    color: var(--fl-muted);
  }
  .jm-search {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: 5px;
    padding: 0 11px;
    color: var(--fl-muted);
  }
  .jm-search input {
    border: 0;
    background: transparent;
    color: var(--fl-text);
    width: 100%;
    padding: 8px 0;
    font: inherit;
  }
  .jm-search:focus-within {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .jm-search input:focus-visible {
    outline: 0;
  }
  .jm-concurrency-list {
    max-height: 50vh;
    overflow: auto;
    margin-top: 12px;
  }
  .jm-concurrency-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 18px;
    padding: 12px 2px;
    border-bottom: 1px solid var(--fl-border);
  }
  .jm-concurrency-row strong,
  .jm-concurrency-row small {
    display: block;
  }
  .jm-concurrency-row strong {
    font-size: 12px;
    font-weight: 550;
  }
  .jm-concurrency-row small {
    font-size: 11px;
    color: var(--fl-muted);
    margin-top: 3px;
  }
  .jm-concurrency-row > span:last-child {
    min-width: 90px;
    max-width: 170px;
    text-align: right;
  }
  .jm-concurrency-row input {
    width: 90px;
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: 5px;
    min-height: 35px;
    padding: 6px 9px;
    font: inherit;
  }
  .jm-concurrency-row input[aria-invalid='true'] {
    border-color: var(--fl-danger);
  }
  .jm-concurrency-row .jm-pending {
    color: var(--fl-warning);
  }
  .jm-concurrency-row .jm-input-error {
    color: var(--fl-danger);
  }
  .jm-muted {
    color: var(--fl-muted);
    font-size: 12px;
    margin-top: 12px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }
</style>
