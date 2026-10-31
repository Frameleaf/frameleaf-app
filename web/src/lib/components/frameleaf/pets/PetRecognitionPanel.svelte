<script lang="ts">
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import {
    isRecognitionRunActive,
    recognitionDestinationKey,
    recognitionReasonKey,
    recognitionRunProgress,
  } from '$lib/frameleaf/pets';
  import { Route } from '$lib/route';
  import { MlDestinationKind, PetRecognitionRunStatus, type PetRecognitionStatusResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCloudOffOutline, mdiInformationOutline, mdiLanConnect, mdiServerOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Where pet recognition runs and how the latest run over the library went (FL-58).
   *
   * Composed from the prototype's grouped-list rows and capsule buttons (apple-style.css
   * `.grouped`, Controls.jsx `Button`), the way the Processing destinations rows read: one line
   * says where the work runs — this server or a computer on the network — or, when it cannot run,
   * the server's own refusal as a sentence with the way to fix it. The page never picks another
   * destination; the administrator's route is the only one shown. Pet recognition never runs on
   * Frameleaf Cloud (its search data stays on this network), so a cloud route only says so.
   */
  interface Props {
    recognition: PetRecognitionStatusResponseDto;
    isAdmin: boolean;
    busy?: boolean;
    onStart: () => void;
    onCancel: () => void;
  }

  let { recognition, isAdmin, busy = false, onStart, onCancel }: Props = $props();

  const run = $derived(recognition.run);
  const active = $derived(isRecognitionRunActive(run));
  const percent = $derived(run ? Math.round(recognitionRunProgress(run) * 100) : 0);
  const onCloud = $derived(recognition.destination?.kind === MlDestinationKind.FrameleafCloud);
  const destinationKey = $derived(recognition.destination && recognitionDestinationKey(recognition.destination.kind));
  const runsHere = $derived(recognition.available && !!destinationKey);
  const destinationIcon = $derived(
    recognition.destination?.kind === MlDestinationKind.Lan ? mdiLanConnect : mdiServerOutline,
  );
</script>

<section class="recognition fl-continuous-corners" aria-labelledby="pet-recognition-heading">
  <header>
    <h2 id="pet-recognition-heading">{$t('frameleaf_pets_recognition_title')}</h2>
    {#if runsHere || active}
      {#if active}
        <FrameleafButton disabled={busy} onclick={onCancel}>{$t('frameleaf_pets_recognition_cancel')}</FrameleafButton>
      {:else}
        <FrameleafButton variant="primary" disabled={busy || !recognition.hasConfirmedPhotos} onclick={onStart}>
          {$t('frameleaf_pets_recognition_start')}
        </FrameleafButton>
      {/if}
    {/if}
  </header>

  {#if recognition.available && destinationKey}
    <p class="row" data-testid="pet-recognition-destination">
      <Icon icon={destinationIcon} size="18" aria-hidden={true} />
      <span>
        {$t(destinationKey, {
          values: { name: recognition.destination?.name },
        })}
      </span>
    </p>
  {:else if recognition.reason}
    <!--
      DISCOVERY-P7: a setting the household left off, or a computer that is away, is a calm notice
      (the "… is off" pattern of Visual search), not a red error: what it means, why, and the way on.
    -->
    <div class="notice" role="status" data-testid="pet-recognition-unavailable">
      <Icon icon={mdiInformationOutline} size="18" aria-hidden={true} />
      <div class="notice-copy">
        <strong>{$t('frameleaf_pets_recognition_off_title')}</strong>
        <p>{$t('frameleaf_pets_recognition_off_body')}</p>
        <p class="note">
          {$t('frameleaf_pets_recognition_off_because', {
            values: { reason: $t(recognitionReasonKey(recognition.reason)) },
          })}
          {#if isAdmin}
            <a href={Route.systemProcessingDestinations()}>{$t('frameleaf_pets_recognition_open_settings')}</a>
          {:else}
            {$t('frameleaf_pets_recognition_ask_admin')}
          {/if}
        </p>
      </div>
    </div>
  {/if}

  {#if onCloud}
    <p class="row" data-testid="pet-recognition-never-cloud">
      <Icon icon={mdiCloudOffOutline} size="18" aria-hidden={true} />
      <span>{$t('frameleaf_pets_recognition_never_cloud')}</span>
    </p>
  {/if}

  {#if runsHere && !recognition.hasConfirmedPhotos}
    <p class="note">{$t('frameleaf_pets_recognition_needs_photos')}</p>
  {/if}

  {#if run}
    <div class="run" data-testid="pet-recognition-run" data-status={run.status}>
      {#if active && run.assetCount === 0}
        <!-- queued: the run has not counted its photos yet, so "0 of 0" would say nothing -->
        <progress aria-label={$t('frameleaf_pets_recognition_progress_label')}></progress>
        <p class="note">{$t('frameleaf_pets_recognition_starting')}</p>
      {:else if active}
        <progress max="100" value={percent} aria-label={$t('frameleaf_pets_recognition_progress_label')}></progress>
        <p class="note">
          {$t('frameleaf_pets_recognition_progress', {
            values: { processed: run.processedCount, total: run.assetCount },
          })}
        </p>
      {:else if run.status === PetRecognitionRunStatus.Completed}
        <p class="note">
          {$t('frameleaf_pets_recognition_completed', {
            values: { total: run.assetCount, count: run.proposalCount },
          })}
        </p>
      {:else if run.status === PetRecognitionRunStatus.Cancelled}
        <p class="note">
          {$t('frameleaf_pets_recognition_cancelled', {
            values: { processed: run.processedCount, total: run.assetCount },
          })}
        </p>
      {:else if run.status === PetRecognitionRunStatus.Failed}
        <p class="note unavailable">{$t('frameleaf_pets_recognition_failed')}</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .recognition {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem;
    margin-bottom: 1rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--fl-text);
  }
  .row {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    margin: 0;
    color: var(--fl-text);
  }
  /* The mark keeps its size beside a line that wraps. */
  .row :global(svg) {
    flex-shrink: 0;
  }
  .unavailable {
    color: var(--fl-danger);
  }
  /* The calm "is off" notice: a muted mark, the title in the text colour, the detail muted. */
  .notice {
    display: flex;
    gap: var(--fl-space-2);
    align-items: flex-start;
    color: var(--fl-text);
  }
  .notice > :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
    color: var(--fl-muted);
  }
  .notice-copy {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-1);
    min-width: 0;
  }
  .notice-copy strong {
    font-weight: 560;
  }
  .notice-copy p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .notice-copy a {
    color: var(--fl-accent);
  }
  .notice-copy a:hover {
    text-decoration: underline;
  }
  .note {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .run {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  progress {
    width: 100%;
    height: 6px;
    accent-color: var(--fl-accent);
  }
</style>
