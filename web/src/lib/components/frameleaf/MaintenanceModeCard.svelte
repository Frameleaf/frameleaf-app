<script lang="ts">
  /**
   * Maintenance → Maintenance mode (FL-81 CC-14/15/16): the mode card of the September 22 prototype
   * (`design/frameleaf/template/src/Maintenance.jsx:145-233`) — the On/Off pill, Status / Reason /
   * Administrators / Everyone else facts, the "What people see" preview and the section links — with
   * the start dialog and its optional reason (`Maintenance.jsx:569-609`), wired to the real
   * `setMaintenanceMode` endpoint instead of the prototype's simulated reducers.
   *
   * A live server in maintenance mode serves only `/maintenance`, so this card is reached while the
   * mode is off; `status` still renders the "on" facts should a caller hold an active status. Starting
   * maintenance restarts the app process and every browser is redirected to the maintenance page by
   * the websocket status event; the reason (at most 200 characters, omitted when blank) is shown there.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { handleSetMaintenanceMode } from '$lib/services/maintenance.service';
  import { MaintenanceAction, type MaintenanceStatusResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiWrenchOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    status?: MaintenanceStatusResponseDto;
    /** Opens another Maintenance section; the card shows a link to each section it is not on. */
    backupsHref?: string;
    integrityHref?: string;
  };

  const { status, backupsHref, integrityHref }: Props = $props();

  const MAINTENANCE_REASON_MAX_LENGTH = 200;

  const active = $derived(status?.active === true);

  let confirmOpen = $state(false);
  let starting = $state(false);
  let reason = $state('');
  const reasonId = $props.id();

  $effect(() => {
    if (!confirmOpen) {
      reason = '';
    }
  });

  const start = async () => {
    starting = true;
    const trimmed = reason.trim();
    try {
      await handleSetMaintenanceMode({ action: MaintenanceAction.Start, ...(trimmed && { reason: trimmed }) });
    } finally {
      starting = false;
      confirmOpen = false;
    }
  };
</script>

<section class="mt-card" aria-labelledby="{reasonId}-title">
  <div class="mt-card-title">
    <div>
      <!-- The page heading already names this section (a section named like its area does not repeat the name). -->
      <h2 class="sr-only" id="{reasonId}-title">{$t('admin.frameleaf_maintenance_mode_title')}</h2>
      <p>{$t('admin.frameleaf_maintenance_mode_description')}</p>
    </div>
    <span class="mt-status" class:is-on={active}>
      {active ? $t('admin.frameleaf_maintenance_mode_on') : $t('admin.frameleaf_maintenance_mode_off')}
    </span>
  </div>
  <div class="mt-mode">
    <div>
      <dl class="mt-facts">
        <dt>{$t('admin.frameleaf_maintenance_fact_status')}</dt>
        <dd>{active ? $t('admin.frameleaf_maintenance_mode_on') : $t('admin.frameleaf_maintenance_mode_off')}</dd>
        {#if active}
          <dt>{$t('admin.frameleaf_maintenance_fact_reason')}</dt>
          <dd>{status?.reason || $t('admin.frameleaf_maintenance_no_reason')}</dd>
        {/if}
        <dt>{$t('admin.frameleaf_maintenance_fact_administrators')}</dt>
        <dd>{$t('admin.frameleaf_maintenance_fact_administrators_value')}</dd>
        <dt>{$t('admin.frameleaf_maintenance_fact_everyone_else')}</dt>
        <dd>{$t('admin.frameleaf_maintenance_fact_everyone_else_value')}</dd>
      </dl>
      <div class="mt-actions">
        {#if !active}
          <Button onclick={() => (confirmOpen = true)}>
            <Icon icon={mdiWrenchOutline} size="1em" aria-hidden={true} />
            {$t('admin.frameleaf_maintenance_start')}
          </Button>
        {/if}
        {#if backupsHref}
          <a class="button" href={backupsHref}>{$t('admin.frameleaf_maintenance_backups_title')}</a>
        {/if}
        {#if integrityHref}
          <a class="button" href={integrityHref}>{$t('admin.frameleaf_maintenance_integrity_title')}</a>
        {/if}
      </div>
    </div>
    <div class="mt-preview" role="group" aria-label={$t('admin.frameleaf_maintenance_preview_label')}>
      <Icon icon={mdiWrenchOutline} size="28" aria-hidden={true} />
      <strong>{$t('frameleaf_maintenance_page_title')}</strong>
      <p>{$t('frameleaf_maintenance_page_body')}</p>
      <small>{$t('admin.frameleaf_maintenance_preview_caption')}</small>
    </div>
  </div>
</section>

<Dialog title={$t('admin.frameleaf_maintenance_start_confirm_title')} closeLabel={$t('close')} bind:open={confirmOpen}>
  <p class="dialog-copy">{$t('admin.frameleaf_maintenance_start_confirm_body')}</p>
  <label class="mt-dialog-field" for={reasonId}>
    {$t('admin.frameleaf_maintenance_reason_label')}
    <input
      id={reasonId}
      data-initial-focus
      maxlength={MAINTENANCE_REASON_MAX_LENGTH}
      placeholder={$t('admin.frameleaf_maintenance_reason_placeholder')}
      bind:value={reason}
      disabled={starting}
    />
  </label>
  {#snippet actions()}
    <Button onclick={() => (confirmOpen = false)} disabled={starting}>{$t('cancel')}</Button>
    <Button variant="primary" onclick={start} disabled={starting}>
      {$t('admin.frameleaf_maintenance_start')}
    </Button>
  {/snippet}
</Dialog>

<style>
  /* design/frameleaf/template/src/maintenance.css `.mt-card` … `.mt-preview`. */
  .mt-card {
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 20px;
    min-width: 0;
  }
  .mt-card-title {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
  }
  .mt-card-title h2 {
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 600;
  }
  .mt-card-title p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.6;
  }
  .mt-status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    font-size: var(--fl-font-small);
    white-space: nowrap;
  }
  .mt-status::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fl-muted);
  }
  .mt-status.is-on::before {
    background: var(--fl-warning);
  }
  .mt-mode {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    gap: 20px;
  }
  .mt-facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 8px 18px;
    margin: 0 0 16px;
    font-size: var(--fl-font-small);
  }
  .mt-facts dt {
    color: var(--fl-muted);
  }
  .mt-facts dd {
    margin: 0;
  }
  .mt-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .mt-actions a.button {
    text-decoration: none;
  }
  .mt-preview {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 22px 20px;
    text-align: center;
    background: var(--fl-canvas);
    color: var(--fl-muted);
  }
  .mt-preview strong {
    display: block;
    margin: 8px 0 4px;
    color: var(--fl-text);
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .mt-preview p {
    margin: 0;
    font-size: var(--fl-font-small);
    line-height: 1.6;
  }
  .mt-preview small {
    display: block;
    margin-top: 12px;
    font-size: var(--fl-font-micro);
  }
  .dialog-copy {
    margin: 0 0 14px;
    color: var(--fl-text);
  }
  .mt-dialog-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .mt-dialog-field input {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    padding: 6px 9px;
    font: inherit;
  }
  @media (max-width: 700px) {
    .mt-mode {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
