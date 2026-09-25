<script lang="ts">
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import {
    isRecognitionRunActive,
    recognitionDestinationKey,
    recognitionReasonKey,
    recognitionRunProgress,
  } from '$lib/frameleaf/pets';
  import { Route } from '$lib/route';
  import { MlDestinationKind, PetRecognitionRunStatus, type PetRecognitionStatusResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiCloudOutline, mdiLanConnect, mdiServerOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Where pet recognition runs and how the latest run over the library went (FL-58).
   *
   * Composed from the prototype's grouped-list rows and capsule buttons (apple-style.css
   * `.grouped`, Controls.jsx `Button`), the way the Processing destinations rows read: one line
   * says where the work runs — this server, a computer on the network, or Frameleaf Cloud — or,
   * when it cannot run, the server's own refusal as a sentence with the way to fix it. The page
   * never picks another destination; the administrator's route is the only one shown.
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
  const destinationIcon = $derived.by(() => {
    switch (recognition.destination?.kind) {
      case MlDestinationKind.Lan: {
        return mdiLanConnect;
      }
      case MlDestinationKind.FrameleafCloud: {
        return mdiCloudOutline;
      }
      default: {
        return mdiServerOutline;
      }
    }
  });
</script>

<section class="recognition fl-continuous-corners" aria-labelledby="pet-recognition-heading">
  <header>
    <h2 id="pet-recognition-heading">{$t('frameleaf_pets_recognition_title')}</h2>
    {#if recognition.available || active}
      {#if active}
        <FrameleafButton disabled={busy} onclick={onCancel}>{$t('frameleaf_pets_recognition_cancel')}</FrameleafButton>
      {:else}
        <FrameleafButton variant="primary" disabled={busy || !recognition.hasConfirmedPhotos} onclick={onStart}>
          {$t('frameleaf_pets_recognition_start')}
        </FrameleafButton>
      {/if}
    {/if}
  </header>

  {#if recognition.available && recognition.destination}
    <p class="row" data-testid="pet-recognition-destination">
      <Icon icon={destinationIcon} size="18" aria-hidden={true} />
      <span>
        {$t(recognitionDestinationKey(recognition.destination.kind), {
          values: { name: recognition.destination.name },
        })}
      </span>
    </p>
  {:else if recognition.reason}
    <p class="row unavailable" role="status" data-testid="pet-recognition-unavailable">
      <Icon icon={mdiAlertCircleOutline} size="18" aria-hidden={true} />
      <span>
        {$t('frameleaf_pets_recognition_unavailable')}
        {$t(recognitionReasonKey(recognition.reason))}
        {#if isAdmin}
          <a href={Route.systemProcessingDestinations()}>{$t('frameleaf_pets_recognition_open_settings')}</a>
        {:else}
          {$t('frameleaf_pets_recognition_ask_admin')}
        {/if}
      </span>
    </p>
  {/if}

  {#if recognition.available && !recognition.hasConfirmedPhotos}
    <p class="note">{$t('frameleaf_pets_recognition_needs_photos')}</p>
  {/if}

  {#if run}
    <div class="run" data-testid="pet-recognition-run" data-status={run.status}>
      {#if active}
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
  .row a {
    color: var(--fl-accent);
    text-decoration: underline;
  }
  .unavailable {
    color: var(--fl-danger);
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
