<script lang="ts">
  /**
   * Choose candidate originals, or recover damaged originals from a verified copy (FL-69).
   *
   * Ported from the September 22, 2026 prototype's `UtilityRecovery.jsx`: pick the search
   * locations, review each finding's candidates with their checksum and decode evidence, and
   * confirm. Two production additions the prototype's sample data did not need:
   *
   * - **Search selected locations** runs a real, durable search of the chosen locations for the
   *   findings in the dialog; its candidates appear here when it finishes.
   * - Candidates carry the location they were found in, so the location checkboxes filter them.
   *
   * Nothing is changed from here without the reviewer's explicit choice. Replacement is offered
   * only for a copy with an exact checksum and a successful decode, and only with the consent that
   * the damaged source is kept.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    candidatesIn,
    formatBytes,
    isRecoveryCandidate,
    isVerified,
    recoveryChoicesValid,
    STATUS_LABEL_KEY,
    type LibraryCareRow,
  } from '$lib/frameleaf/library-care';
  import { MediaHealthRootKind, type MediaHealthRootDto } from '@immich/sdk';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    open = $bindable(false),
    mode,
    rows,
    roots,
    ownerName,
    busy = false,
    searching = false,
    onSearch,
    onCommit,
  }: {
    open?: boolean;
    mode: 'locate' | 'replace';
    rows: LibraryCareRow[];
    roots: MediaHealthRootDto[];
    ownerName: (ownerId: string) => string;
    busy?: boolean;
    /** A search for these findings is running; its results arrive in `rows`. */
    searching?: boolean;
    onSearch: (rootIds: string[]) => void;
    onCommit: (choices: Record<string, string>) => void;
  } = $props();

  // The reviewer's own choices start from what the dialog opened with and are theirs from then on:
  // later updates to `rows` (a search finishing) add candidates without undoing a choice.
  // Library storage is searched by default, and recovery locations when replacing damage.
  let rootIds = $state<string[]>(
    untrack(() =>
      roots
        .filter(
          (root) =>
            root.kind === MediaHealthRootKind.Managed ||
            (mode === 'replace'
              ? root.kind === MediaHealthRootKind.Recovery
              : root.kind === MediaHealthRootKind.Library),
        )
        .map(({ id }) => id),
    ),
  );
  let choices = $state<Record<string, string>>(
    untrack(() =>
      Object.fromEntries(
        rows.flatMap((row) => {
          const chosen = row.candidates.find((candidate) => candidate.chosen);
          return chosen ? [[row.id, chosen.id]] : [];
        }),
      ),
    ),
  );
  let consent = $state(false);

  const valid = $derived(recoveryChoicesValid(rows, choices, rootIds, mode));
  const canCommit = $derived(valid && (mode !== 'replace' || consent) && !busy);

  const rootLabel = (root: MediaHealthRootDto) =>
    root.kind === MediaHealthRootKind.Managed ? $t('library_care_root_managed') : root.label;

  const toggleRoot = (id: string) => {
    rootIds = rootIds.includes(id) ? rootIds.filter((rootId) => rootId !== id) : [...rootIds, id];
  };

  const candidateEvidence = (candidate: LibraryCareRow['candidates'][number]) => {
    const checksum = candidate.checksumMatch
      ? $t('library_care_checksum_exact')
      : $t('library_care_checksum_different');
    const decode = candidate.decodeValid
      ? $t('library_care_decode_validated')
      : $t('library_care_decode_not_validated');
    const size = typeof candidate.evidence?.sizeInBytes === 'number' ? candidate.evidence.sizeInBytes : null;
    return [`${$t('library_care_checksum')}: ${checksum}`, `${$t('library_care_decode')}: ${decode}`, formatBytes(size)]
      .filter(Boolean)
      .join(' · ');
  };
</script>

<Dialog
  bind:open
  title={mode === 'replace' ? $t('library_care_recover_title') : $t('library_care_locate_title')}
  closeLabel={$t('close')}
>
  <div class="recovery">
    <p>{mode === 'replace' ? $t('library_care_recover_intro') : $t('library_care_locate_intro')}</p>

    <fieldset>
      <legend>{$t('library_care_search_locations')}</legend>
      {#each roots as root (root.id)}
        <label class="check">
          <input type="checkbox" checked={rootIds.includes(root.id)} onchange={() => toggleRoot(root.id)} />
          <span>
            {rootLabel(root)}
            {#if root.paths.length > 0}
              <small>{root.paths.join(', ')}</small>
            {/if}
          </span>
        </label>
      {/each}
      <div class="search">
        <Button disabled={rootIds.length === 0 || searching || busy} onclick={() => onSearch(rootIds)}>
          {searching ? $t('library_care_searching') : $t('library_care_search_selected')}
        </Button>
        <small>{$t('library_care_search_hint')}</small>
      </div>
    </fieldset>

    {#each rows as row (row.id)}
      {@const visible = candidatesIn(row, rootIds)}
      <section class="result">
        <h3>{row.name}</h3>
        <p>
          {[ownerName(row.ownerId), formatBytes(row.sizeInBytes), $t(STATUS_LABEL_KEY[row.status])]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {#each visible as candidate (candidate.id)}
          {@const selectable = mode === 'replace' ? isRecoveryCandidate(candidate) : isVerified(candidate)}
          <label class="check" class:muted={!selectable}>
            <input
              type="radio"
              name={`candidate-${row.id}`}
              disabled={!selectable}
              checked={choices[row.id] === candidate.id}
              onchange={() => (choices = { ...choices, [row.id]: candidate.id })}
            />
            <span>
              <strong>{candidate.candidatePath}</strong>
              <small>{candidateEvidence(candidate)}</small>
            </span>
          </label>
        {/each}
        {#if rootIds.length === 0}
          <p class="note">{$t('library_care_select_location')}</p>
        {:else if visible.length === 0}
          <p class="note">{$t('library_care_no_candidates')}</p>
        {/if}
      </section>
    {/each}

    {#if mode === 'replace'}
      <label class="check consent">
        <input type="checkbox" bind:checked={consent} />
        <span>{$t('library_care_recover_consent')}</span>
      </label>
    {/if}

    <p class="policy">{$t('library_care_recover_policy')}</p>

    <footer>
      <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!canCommit} onclick={() => onCommit(choices)}>
        {mode === 'replace' ? $t('library_care_recover_commit') : $t('library_care_locate_commit')}
      </Button>
    </footer>
  </div>
</Dialog>

<style>
  .recovery {
    display: grid;
    gap: 0.875rem;
    margin-top: 0.75rem;
    min-width: min(36rem, 100%);
    max-width: 44rem;
    font-size: var(--fl-font-size, 0.875rem);
  }
  p {
    margin: 0;
  }
  fieldset {
    display: grid;
    gap: 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0.625rem 0.75rem;
  }
  legend {
    color: var(--fl-muted);
    font-size: 0.75rem;
    padding: 0 0.25rem;
  }
  .check {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    min-width: 0;
  }
  .check input {
    margin-top: 0.1875rem;
    accent-color: var(--fl-accent);
  }
  .check span {
    display: grid;
    gap: 0.125rem;
    min-width: 0;
  }
  .check strong {
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .check small,
  .search small {
    color: var(--fl-muted);
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }
  .check.muted {
    color: var(--fl-muted);
  }
  .search {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
  }
  .result {
    display: grid;
    gap: 0.375rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    padding: 0.625rem 0.75rem;
  }
  .result h3 {
    font-size: 0.875rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .result > p,
  .note,
  .policy {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .consent {
    font-size: 0.8125rem;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
