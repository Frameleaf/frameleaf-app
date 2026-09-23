<script lang="ts">
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { hasNewSinceVisit, newSinceIsPartial, newSinceMessageKey } from '$lib/frameleaf/shared-space';
  import { handleError } from '$lib/utils/handle-error';
  import { markSharedSpaceVisited, type AlbumResponseDto, type SharedSpaceNewResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCheckAll, mdiFilterOutline, mdiFilterRemoveOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * "New since your last visit" for one shared space (FL-55).
   *
   * The count is what *other* members added after this member last said they had seen the space;
   * their own additions are never news to them, and anything marked sensitive or Locked is left out
   * by the server before it counts.
   *
   * Seeing the banner does not clear it. Marking the space seen is a button the member presses,
   * because opening a space on a phone for a second is not the same as having looked at what is new,
   * and a list that empties itself on a glance is a list nobody can trust.
   */
  interface Props {
    space: AlbumResponseDto;
    info: SharedSpaceNewResponseDto | null;
    /** Whether the timeline is narrowed to the new items. The page owns it. */
    showing: boolean;
    onToggle: (showing: boolean) => void;
    /** The server's answer after marking the space seen. */
    onMarked: (info: SharedSpaceNewResponseDto) => void;
  }

  let { space, info, showing, onToggle, onMarked }: Props = $props();

  let busy = $state(false);
  let status = $state('');

  const markSeen = async () => {
    busy = true;
    try {
      const next = await markSharedSpaceVisited({ id: space.id });
      onToggle(false);
      onMarked(next);
      status = $t('frameleaf_spaces_new_marked');
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_new'));
    } finally {
      busy = false;
    }
  };
</script>

{#if info && hasNewSinceVisit(info)}
  <section class="new-since" aria-labelledby="frameleaf-space-new">
    <p id="frameleaf-space-new" class="summary">
      {$t(newSinceMessageKey(info), { values: { count: info.assetCount } })}
      {#if showing && newSinceIsPartial(info)}
        <span class="partial">{$t('frameleaf_spaces_new_partial', { values: { count: info.assetIds.length } })}</span>
      {/if}
    </p>
    <div class="actions">
      <button type="button" aria-pressed={showing} disabled={busy} onclick={() => onToggle(!showing)}>
        <Icon icon={showing ? mdiFilterRemoveOutline : mdiFilterOutline} size="16" aria-hidden={true} />
        {showing ? $t('frameleaf_spaces_new_show_all') : $t('frameleaf_spaces_new_show')}
      </button>
      <button type="button" disabled={busy} onclick={markSeen}>
        <Icon icon={mdiCheckAll} size="16" aria-hidden={true} />
        {$t('frameleaf_spaces_new_mark_seen')}
      </button>
    </div>
  </section>
{/if}

<Status message={status} {busy} />

<style>
  .new-since {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--fl-accent);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .summary {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
  }
  .partial {
    display: block;
    font-weight: 400;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.75rem;
    min-height: 36px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-panel);
    color: var(--fl-text);
    font-size: 0.75rem;
    font-weight: 600;
  }
  button[aria-pressed='true'] {
    border-color: var(--fl-accent);
  }
  button:disabled {
    opacity: 0.6;
  }
</style>
