<script lang="ts">
  /**
   * Frameleaf FL-57: correction history for a person. There is no equivalent screen in
   * the design prototype (`People.jsx`/`PersonDetail.jsx` only cover merge suggestions
   * and the fix-incorrect-match flow) — this view is new for this story, over the real
   * `GET /people/:id/corrections` endpoint added alongside it.
   *
   * A "correction" is a face a human explicitly moved onto this person: a reassignment
   * from the viewer's face menu (FL-38), or the "someone new"/"someone existing" actions
   * in the split flow (`UnmergeFaceSelector.svelte`). Faces the facial-recognition job
   * assigned on its own, and nobody has since touched, do not appear here — the server
   * distinguishes the two with a dedicated `correctedAt` marker so reprocessing a face's
   * embedding can never quietly erase what a person corrected.
   */
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, getCorrectionHistory, type PersonCorrectionDto, type PersonResponseDto } from '@immich/sdk';
  import { Icon, LoadingSpinner } from '@immich/ui';
  import { mdiClose } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    person: PersonResponseDto;
    close: () => void;
  }

  let { person, close }: Props = $props();

  let loading = $state(true);
  let corrections: PersonCorrectionDto[] = $state([]);
  let loadError = $state(false);

  onMount(async () => {
    try {
      const result = await getCorrectionHistory({ id: person.id });
      corrections = result.corrections;
    } catch (error) {
      loadError = true;
      handleError(error, $t('frameleaf_people_correction_history_error'));
    } finally {
      loading = false;
    }
  });

  const formatCorrectedAt = (value: string) => DateTime.fromISO(value).toLocaleString(DateTime.DATETIME_MED);
</script>

<section class="fl-correction-history" role="dialog" aria-modal="true" aria-labelledby="fl-correction-history-title">
  <header class="fl-correction-history-header">
    <h2 id="fl-correction-history-title">
      {$t('frameleaf_people_correction_history_title', { values: { name: person.name || $t('add_a_name') } })}
    </h2>
    <button type="button" class="fl-icon-button" aria-label={$t('close')} onclick={close}>
      <Icon icon={mdiClose} size="18" />
    </button>
  </header>
  <p class="fl-correction-history-hint">{$t('frameleaf_people_correction_history_hint')}</p>
  {#if loading}
    <div class="fl-correction-history-loading"><LoadingSpinner /></div>
  {:else if loadError}
    <p class="fl-correction-history-empty">{$t('frameleaf_people_correction_history_error')}</p>
  {:else if corrections.length === 0}
    <p class="fl-correction-history-empty">{$t('frameleaf_people_correction_history_empty')}</p>
  {:else}
    <ul class="fl-correction-history-list">
      {#each corrections as correction (correction.faceId)}
        <li>
          <a class="fl-correction-history-row" href={Route.viewAsset({ id: correction.assetId })}>
            <img
              class="fl-correction-history-thumb"
              src={getAssetMediaUrl({ id: correction.assetId, size: AssetMediaSize.Thumbnail })}
              alt=""
              loading="lazy"
            />
            <span class="fl-correction-history-date">{formatCorrectedAt(correction.correctedAt)}</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
  <footer class="fl-correction-history-footer">
    <FrameleafButton onclick={close}>{$t('close')}</FrameleafButton>
  </footer>
</section>

<style>
  .fl-correction-history {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    padding: 1rem;
    overflow-y: auto;
    background: var(--fl-panel);
  }
  .fl-correction-history-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .fl-correction-history-header h2 {
    font-size: 1.125rem;
    color: var(--fl-text);
  }
  .fl-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    color: var(--fl-muted);
    background: transparent;
    border: 0;
    border-radius: 50%;
  }
  .fl-icon-button:hover {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .fl-correction-history-hint {
    margin-top: 0.25rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .fl-correction-history-loading {
    display: flex;
    justify-content: center;
    padding: 2rem;
  }
  .fl-correction-history-empty {
    padding: 2rem 0;
    text-align: center;
    color: var(--fl-muted);
  }
  .fl-correction-history-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    gap: 0.75rem;
    margin-top: 1rem;
  }
  .fl-correction-history-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    text-decoration: none;
    border-radius: var(--fl-radius-card);
  }
  .fl-correction-history-thumb {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: var(--fl-radius-card);
  }
  .fl-correction-history-date {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .fl-correction-history-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 1rem;
  }
</style>
