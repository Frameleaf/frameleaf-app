<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { eagleImportStore, type EagleImportSaved } from '$lib/frameleaf/eagle/eagle-import-record';
  import { eagleImportUi } from '$lib/frameleaf/eagle/eagle-import-status.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Icon, toastManager } from '@frameleaf/ui';
  import { mdiFolderOpenOutline, mdiPauseCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Shown in Boards after the tab closed part-way through an Eagle import from this computer
   * (prototype `EaglePausedBanner`, README point 39): "paused at 412 of 1,207", with Carry on, which
   * asks for the library again, and Stop and keep. It reads only this browser's record.
   */
  let paused = $state<EagleImportSaved | undefined>();
  const done = $derived(paused ? Object.keys(paused.outcomes).length : 0);

  $effect(() => {
    void eagleImportUi.revision;
    const ownerId = authManager.authenticated ? authManager.user.id : undefined;
    const live = eagleImportUi.run;
    if (!ownerId || (live && (live.state === 'running' || live.state === 'stopping'))) {
      paused = undefined;
      return;
    }
    let current = true;
    void eagleImportStore()
      .unfinished(ownerId)
      .then((records) => {
        if (current) {
          paused = records.find(({ record }) => record.status === 'running');
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  });

  const stop = async () => {
    if (!paused) {
      return;
    }
    const count = done;
    await eagleImportStore()
      .save({ ...paused.record, status: 'stopped', updatedAt: new Date().toISOString() })
      .catch(() => undefined);
    paused = undefined;
    eagleImportUi.revision++;
    toastManager.info($t('frameleaf_eagle_paused_stopped', { values: { count } }));
  };
</script>

{#if paused}
  <div class="banner" role="status">
    <Icon icon={mdiPauseCircleOutline} size="20" aria-hidden />
    <span>
      <strong>{$t('frameleaf_eagle_paused_title', { values: { done, total: paused.record.total } })}</strong>
      <small>{$t('frameleaf_eagle_paused_body', { values: { name: paused.record.libraryName } })}</small>
    </span>
    <Button onclick={() => void stop()}>{$t('frameleaf_eagle_stop_keep', { values: { count: done } })}</Button>
    <Button variant="primary" onclick={() => eagleImportUi.show()}
      ><Icon icon={mdiFolderOpenOutline} size="16" aria-hidden />{$t('frameleaf_eagle_carry_on')}</Button
    >
  </div>
{/if}

<style>
  .banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3);
    margin: 0 var(--fl-space-4) var(--fl-space-3);
    padding: var(--fl-space-3) var(--fl-space-4);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.875rem;
  }
  .banner > :global(svg) {
    flex: none;
    color: var(--fl-warning);
  }
  .banner > span {
    display: flex;
    flex: 1 1 16rem;
    flex-direction: column;
    gap: 0.125rem;
  }
  small {
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
</style>
