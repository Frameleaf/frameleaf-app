<script lang="ts">
  /**
   * The Job manager's "Create a maintenance job" dialog (FL-71), the template's `ManualDialog` in
   * `JobsManager.jsx`: a searchable list of the server's maintenance tasks with what each does and
   * the queue it runs in. "Review job" hands the chosen task to the Job manager's review, which
   * asks for an acknowledgement where the task is marked "review required".
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { MANUAL_JOBS, manualJobKey, searchTerms, type ManualJobDefinition } from '$lib/frameleaf/job-queues';
  import type { QueueName } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiMagnify } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    open?: boolean;
    queueTitle: (name: QueueName) => string;
    onSelect: (job: ManualJobDefinition) => void;
  };

  let { open = $bindable(false), queueTitle, onSelect }: Props = $props();

  let query = $state('');
  let selected = $state<string>('');

  const titleOf = (job: ManualJobDefinition) => $t(manualJobKey(job.name) as Translations);
  const descriptionOf = (job: ManualJobDefinition) => $t(`${manualJobKey(job.name)}_description` as Translations);

  const matches = $derived(
    MANUAL_JOBS.filter((job) =>
      searchTerms(query).every((term) => `${titleOf(job)} ${descriptionOf(job)}`.toLowerCase().includes(term)),
    ),
  );
  const task = $derived(MANUAL_JOBS.find((job) => job.name === selected));

  // Each opening starts from an empty search and no choice.
  $effect(() => {
    if (!open) {
      return;
    }

    query = '';
    selected = '';
  });

  const review = () => {
    if (!task) {
      return;
    }

    open = false;
    onSelect(task);
  };
</script>

<Dialog title={$t('frameleaf_jobs_manual_title')} closeLabel={$t('close')} wide bind:open>
  <div class="jm-manual">
    <p>{$t('frameleaf_jobs_manual_help')}</p>
    <label class="jm-search">
      <Icon icon={mdiMagnify} size="16px" aria-hidden={true} />
      <input
        aria-label={$t('frameleaf_jobs_manual_search')}
        type="search"
        maxlength="200"
        placeholder={$t('frameleaf_jobs_manual_search_placeholder')}
        bind:value={query}
      />
    </label>
    <div class="jm-manual-list">
      {#each matches as job (job.name)}
        <label class:selected={selected === job.name}>
          <input type="radio" name="manual-job" value={job.name} bind:group={selected} />
          <span>
            <strong>{titleOf(job)}</strong>
            <small>{descriptionOf(job)}</small>
            <em>
              {queueTitle(job.queue)}{job.dangerous ? ` · ${$t('frameleaf_jobs_manual_review_required')}` : ''}
            </em>
          </span>
        </label>
      {:else}
        <p>{$t('frameleaf_jobs_manual_no_matches')}</p>
      {/each}
    </div>
    <footer>
      <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!task} onclick={review}>{$t('frameleaf_jobs_manual_review')}</Button>
    </footer>
  </div>
</Dialog>

<style>
  /* The template's `jobs-manager.css` maintenance job dialog. */
  .jm-manual {
    font-size: 13px;
    line-height: 1.6;
    min-width: min(36rem, 100%);
  }
  .jm-manual > p {
    margin: 0 0 12px;
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
  .jm-manual-list {
    max-height: 48vh;
    overflow: auto;
    margin-top: 12px;
  }
  .jm-manual-list label {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 13px;
    border: 1px solid transparent;
    border-bottom-color: var(--fl-border);
    cursor: pointer;
  }
  .jm-manual-list label.selected {
    border-color: var(--fl-accent);
    border-radius: 5px;
    background: color-mix(in srgb, var(--fl-accent) 6%, transparent);
  }
  .jm-manual-list input {
    accent-color: var(--fl-accent);
    margin-top: 4px;
    flex: none;
  }
  .jm-manual-list strong,
  .jm-manual-list small,
  .jm-manual-list em {
    display: block;
  }
  .jm-manual-list strong {
    font-size: 12px;
    font-weight: 600;
  }
  .jm-manual-list small {
    font-size: 11px;
    color: var(--fl-muted);
    margin-top: 3px;
  }
  .jm-manual-list em {
    font-size: 11px;
    color: var(--fl-accent);
    font-style: normal;
    margin-top: 4px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }
</style>
