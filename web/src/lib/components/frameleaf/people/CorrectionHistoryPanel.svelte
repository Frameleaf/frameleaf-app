<script lang="ts">
  /**
   * Frameleaf FL-57: the correction history of a person, over `GET /people/:id/corrections`
   * (25 decisions a page, "Show more") with Undo (`POST /people/corrections/:id/undo`). The
   * prototype has no history screen; this one is the fix-match side panel's sibling and follows
   * it (`PersonDetail.jsx:43-212` FixMatchPanel, people.css "fix-match side panel": a header, a
   * list of rows with a face crop, a line of copy and a trailing action, a status footer).
   *
   * Each row is one manual decision the owner made about this person: a face moved onto or off
   * them (from the viewer's face menu, fix incorrect match, or a split into someone new), "not
   * a face of anyone", a merge, or a moved face box. The server keeps them in
   * `immich_fork.face_correction`, anchored to the photo's checksum and the face box, so they
   * survive face detection and recognition being run again.
   *
   * The photo of a decision shows only while the owner may still see it: a photo since trashed,
   * moved to Locked, hidden by suppression rules, or not theirs shows "No longer available"
   * instead, never the photo. Undo is offered for moves and removals that were not undone yet;
   * when the face has changed since, the server refuses and the reason is shown on the row.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import FaceCrop from '$lib/components/frameleaf/people/FaceCrop.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    getCorrectionHistory,
    PersonCorrectionAction,
    undoCorrection,
    type PersonCorrectionDto,
    type PersonResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiClose, mdiImageOffOutline } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteMap } from 'svelte/reactivity';

  interface Props {
    person: PersonResponseDto;
    onOpenAsset?: (assetId: string) => void;
    /** Called once when the panel closes, when a change was undone, with the people faces went back to or left. */
    onChanged?: (personIds: string[]) => void;
    close: () => void;
  }

  let { person, onOpenAsset, onChanged, close }: Props = $props();

  const PAGE_SIZE = 25;

  let corrections: PersonCorrectionDto[] = $state([]);
  let page = $state(0);
  let hasMore = $state(false);
  let loading = $state(false);
  let loadError = $state(false);
  let message = $state('');
  let heading: HTMLHeadingElement | undefined = $state();
  const refused = new SvelteMap<string, string>();
  const undoing = new SvelteMap<string, boolean>();
  let changed = false;
  const touched = new Set<string>();
  let previous: Element | null = null;

  const loadPage = async () => {
    loading = true;
    loadError = false;
    try {
      const next = page + 1;
      const result = await getCorrectionHistory({ id: person.id, page: next, size: PAGE_SIZE });
      const known = new Set(corrections.map(({ id }) => id));
      corrections = [...corrections, ...result.corrections.filter(({ id }) => !known.has(id))];
      hasMore = result.hasNextPage;
      page = next;
    } catch (error) {
      loadError = true;
      handleError(error, $t('frameleaf_people_correction_history_error'));
    } finally {
      loading = false;
    }
  };

  const finish = () => {
    if (changed) {
      onChanged?.([...touched]);
    }
    close();
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) {
      return;
    }
    event.preventDefault();
    finish();
  };

  onMount(() => {
    previous = document.activeElement;
    heading?.focus();
    document.addEventListener('keydown', onKeydown);
    void loadPage();
  });

  onDestroy(() => {
    document.removeEventListener('keydown', onKeydown);
    if (previous instanceof HTMLElement && previous.isConnected) {
      previous.focus();
    }
  });

  const refusal = (error: unknown): string | undefined => {
    const reason = (error as { data?: { reason?: string } } | undefined)?.data?.reason;
    switch (reason) {
      case 'already-undone': {
        return $t('frameleaf_people_correction_undo_already');
      }
      case 'face-changed': {
        return $t('frameleaf_people_correction_undo_face_changed');
      }
      case 'face-gone': {
        return $t('frameleaf_people_correction_undo_face_gone');
      }
      case 'person-gone': {
        return $t('frameleaf_people_correction_undo_person_gone');
      }
      case 'source-changed': {
        return $t('frameleaf_people_correction_undo_source_changed');
      }
      case 'not-undoable': {
        return $t('frameleaf_people_correction_undo_not_undoable');
      }
      default: {
        return undefined;
      }
    }
  };

  const undo = async (correction: PersonCorrectionDto) => {
    undoing.set(correction.id, true);
    refused.delete(correction.id);
    try {
      const undone = await undoCorrection({ id: correction.id });
      corrections = corrections.map((entry) => (entry.id === undone.id ? undone : entry));
      changed = true;
      for (const entry of [undone.fromPerson, undone.toPerson]) {
        if (entry?.exists) {
          touched.add(entry.id);
        }
      }
      message = $t('frameleaf_people_correction_undone_status');
    } catch (error) {
      const reason = refusal(error);
      if (reason) {
        refused.set(correction.id, reason);
        message = reason;
      } else {
        handleError(error, $t('frameleaf_people_correction_undo_error'));
      }
    } finally {
      undoing.delete(correction.id);
    }
  };

  const nameOf = (entry: PersonCorrectionDto['fromPerson']) => entry?.name || $t('unnamed_person');

  const describe = (correction: PersonCorrectionDto) => {
    const values = { from: nameOf(correction.fromPerson), to: nameOf(correction.toPerson) };
    switch (correction.action) {
      case PersonCorrectionAction.Reassign: {
        return correction.fromPerson
          ? $t('frameleaf_people_correction_action_reassign', { values })
          : $t('frameleaf_people_correction_action_assign', { values });
      }
      case PersonCorrectionAction.NewPerson: {
        return $t('frameleaf_people_correction_action_new_person', { values });
      }
      case PersonCorrectionAction.Unassign: {
        return $t('frameleaf_people_correction_action_unassign', { values });
      }
      case PersonCorrectionAction.Remove: {
        return $t('frameleaf_people_correction_action_remove');
      }
      case PersonCorrectionAction.Merge: {
        return $t('frameleaf_people_correction_action_merge', { values });
      }
      case PersonCorrectionAction.BoxMove: {
        return $t('frameleaf_people_correction_action_box_move');
      }
    }
  };

  const formatAt = (value: string) => DateTime.fromISO(value).toLocaleString(DateTime.DATETIME_MED);
</script>

<div class="pd-history" role="dialog" aria-labelledby="pd-history-title" aria-modal="false">
  <header class="pd-history-header">
    <div>
      <h2 id="pd-history-title" bind:this={heading} tabindex="-1">
        {$t('frameleaf_people_correction_history_title', { values: { name: person.name || $t('add_a_name') } })}
      </h2>
      <p>{$t('frameleaf_people_correction_history_hint')}</p>
    </div>
    <IconButton label={$t('close')} onclick={finish}>
      <Icon icon={mdiClose} size="18" aria-hidden="true" />
    </IconButton>
  </header>
  <ul class="pd-history-list">
    {#each corrections as correction (correction.id)}
      <li class="pd-history-row" class:is-undone={!!correction.undoneAt}>
        {#if correction.evidence}
          <button
            type="button"
            class="pd-history-thumb"
            aria-label={$t('frameleaf_people_correction_open_photo')}
            onclick={() => onOpenAsset?.(correction.evidence!.assetId)}
          >
            <FaceCrop
              src={getAssetMediaUrl({ id: correction.evidence.assetId, size: AssetMediaSize.Preview })}
              box={correction.evidence.box}
              size={56}
            />
          </button>
        {:else if correction.evidenceRevoked}
          <span
            class="pd-history-thumb is-unavailable fl-squircle"
            title={$t('frameleaf_people_correction_unavailable')}
          >
            <Icon icon={mdiImageOffOutline} size="20" aria-hidden="true" />
          </span>
        {:else}
          <span class="pd-history-thumb is-empty fl-squircle" aria-hidden="true"></span>
        {/if}
        <div class="pd-history-copy">
          <strong>{describe(correction)}</strong>
          <span>
            {formatAt(correction.createdAt)}
            {#if correction.evidenceRevoked}
              · {$t('frameleaf_people_correction_unavailable')}
            {/if}
          </span>
          {#if correction.undoneAt}
            <em>{$t('frameleaf_people_correction_undone', { values: { date: formatAt(correction.undoneAt) } })}</em>
          {:else if refused.get(correction.id)}
            <em class="refused">{refused.get(correction.id)}</em>
          {/if}
        </div>
        {#if correction.undoable && !correction.undoneAt}
          <Button
            disabled={undoing.get(correction.id)}
            onclick={() => void undo(correction)}
            label={$t('frameleaf_people_correction_undo_label', { values: { change: describe(correction) } })}
          >
            {$t('undo')}
          </Button>
        {/if}
      </li>
    {/each}
  </ul>
  {#if loading}
    <p class="note" role="status">{$t('loading')}</p>
  {:else if loadError}
    <p class="note">{$t('frameleaf_people_correction_history_error')}</p>
  {:else if corrections.length === 0}
    <p class="note">{$t('frameleaf_people_correction_history_empty')}</p>
  {:else if hasMore}
    <div class="more">
      <Button onclick={() => void loadPage()}>{$t('frameleaf_people_show_more')}</Button>
    </div>
  {/if}
  <footer class="pd-history-footer">
    <span role="status" aria-live="polite">{message}</span>
    <Button variant="primary" onclick={finish}>{$t('done')}</Button>
  </footer>
</div>

<style>
  /* template/src/people.css "fix-match side panel", shared with FixMatchPanel. */
  .pd-history {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    width: min(420px, 100vw);
    color: var(--fl-text);
    background: var(--fl-panel);
    border-left: 1px solid var(--fl-border);
    box-shadow: var(--fl-shadow-2);
    animation: pd-history-in var(--fl-motion-slow) var(--fl-ease);
  }
  @keyframes pd-history-in {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
    to {
      transform: none;
      opacity: 1;
    }
  }
  .pd-history-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 20px 20px 16px;
    border-bottom: 1px solid var(--fl-border);
  }
  .pd-history-header h2 {
    margin: 0 0 4px;
    font-size: 17px;
    font-weight: 600;
  }
  .pd-history-header h2:focus {
    outline: none;
  }
  .pd-history-header p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .pd-history-list {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 10px;
    overflow: auto;
    list-style: none;
  }
  .pd-history-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    border-radius: var(--fl-radius-card);
  }
  .pd-history-row:hover {
    background: var(--fl-raised);
  }
  .pd-history-row.is-undone {
    opacity: 0.6;
  }
  .pd-history-thumb {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    padding: 0;
    color: var(--fl-muted);
    background: none;
    border: 0;
  }
  .pd-history-thumb.is-unavailable,
  .pd-history-thumb.is-empty {
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
  }
  .pd-history-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .pd-history-copy strong {
    font-weight: 500;
  }
  .pd-history-copy span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .pd-history-copy em {
    color: var(--fl-teal);
    font-size: var(--fl-font-small);
    font-style: normal;
  }
  .pd-history-copy em.refused {
    color: var(--fl-warning-text);
  }
  .note {
    padding: 0 20px 12px;
    color: var(--fl-muted);
  }
  .more {
    display: flex;
    justify-content: center;
    padding: 0 20px 12px;
  }
  .pd-history-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 20px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    border-top: 1px solid var(--fl-border);
  }
  @media (prefers-reduced-motion: reduce) {
    .pd-history {
      animation-name: pd-history-fade;
    }
    @keyframes pd-history-fade {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
  }
  @media (max-width: 700px) {
    .pd-history {
      top: auto;
      left: 0;
      width: 100%;
      max-height: 82dvh;
      border-top: 1px solid var(--fl-border);
      border-left: 0;
      border-radius: var(--fl-radius-card) var(--fl-radius-card) 0 0;
    }
  }
</style>
