<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    cancelLocationScan,
    getLocationScanStatus,
    startLocationScan,
    type LocationScanStatusResponseDto,
  } from '@frameleaf/sdk';
  import { onDestroy, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  const statusKeys = {
    queued: 'frameleaf_location_scan_queued',
    preparing: 'frameleaf_location_scan_preparing',
    uploading: 'frameleaf_location_scan_uploading',
    running: 'frameleaf_location_scan_running',
    paused: 'frameleaf_location_scan_paused',
    completed: 'frameleaf_location_scan_completed',
    failed: 'frameleaf_location_scan_failed',
    cancelled: 'frameleaf_location_scan_cancelled',
  } as const;

  let response = $state<LocationScanStatusResponseDto>();
  let consent = $state(false);
  let refresh = $state(false);
  let busy = $state(false);
  let reading = $state(false);
  let failure = $state<'load' | 'start' | 'cancel' | null>(null);
  const scan = $derived(response?.scan);
  const active = $derived(!!scan && ['queued', 'preparing', 'uploading', 'running', 'paused'].includes(scan.status));
  let generation = 0;
  let revision = 0;
  let alive = true;
  onDestroy(() => {
    alive = false;
  });
  const captureView = () => {
    const owner = generation;
    const isCurrentSession = authManager.captureSession();
    return () => alive && owner === generation && isCurrentSession();
  };

  const load = async () => {
    if (busy) {
      return;
    }
    const isCurrent = captureView();
    const request = ++revision;
    reading = true;
    try {
      const next = await getLocationScanStatus();
      if (isCurrent() && request === revision) {
        response = next;
        failure = null;
      }
    } catch {
      if (isCurrent() && request === revision) {
        failure = 'load';
      }
    } finally {
      if (isCurrent() && request === revision) {
        reading = false;
      }
    }
  };

  $effect(() => {
    const account = authManager.authenticated && !authManager.isSharedLink ? authManager.user.id : null;
    generation++;
    revision++;
    response = undefined;
    consent = false;
    refresh = false;
    failure = null;
    busy = false;
    reading = false;
    if (account) {
      untrack(() => void load());
    }
  });

  $effect(() => {
    if (!scan || !active || !response?.enabled || busy || reading || failure) {
      return;
    }
    const timer = setTimeout(() => void load(), 10_000);
    return () => clearTimeout(timer);
  });

  const start = async () => {
    if (!consent || !response?.enabled || !response.available || active || busy || failure) {
      return;
    }
    const isCurrent = captureView();
    const selectedRefresh = refresh;
    consent = false;
    refresh = false;
    busy = true;
    reading = false;
    revision++;
    try {
      const next = await startLocationScan({ startLocationScanDto: { consent: true, refresh: selectedRefresh } });
      if (isCurrent()) {
        response = next;
        failure = null;
      }
    } catch {
      if (isCurrent()) {
        failure = 'start';
      }
    } finally {
      if (isCurrent()) {
        busy = false;
      }
    }
  };

  const cancel = async () => {
    if (!scan || !active || busy) {
      return;
    }
    const isCurrent = captureView();
    busy = true;
    reading = false;
    revision++;
    try {
      await cancelLocationScan({ id: scan.id });
      if (isCurrent()) {
        busy = false;
        await load();
      }
    } catch {
      if (isCurrent()) {
        failure = 'cancel';
      }
    } finally {
      if (isCurrent()) {
        busy = false;
      }
    }
  };
</script>

{#if response?.enabled || scan || failure}
  <Section title={$t('frameleaf_location_scan_title')} description={$t('frameleaf_location_scan_description')}>
    {#if scan}
      <div class="progress" role="status">
        <strong>{$t(statusKeys[scan.status])}</strong>
        <span
          >{$t('frameleaf_location_scan_progress', { values: { processed: scan.processed, total: scan.total } })}</span
        >
        {#if scan.status === 'paused' && scan.reason}<span>{scan.reason}</span>{/if}
      </div>
      {#if active}
        <progress
          aria-label={$t('frameleaf_location_scan_progress_label')}
          max={Math.max(1, scan.total)}
          value={scan.total > 0 ? scan.processed : undefined}
          aria-valuenow={scan.total > 0 ? scan.processed : undefined}
          aria-valuemax={scan.total > 0 ? scan.total : undefined}
        ></progress>
      {/if}
      <Facts
        rows={[
          { label: $t('frameleaf_location_scan_matched'), value: String(scan.matched) },
          { label: $t('frameleaf_location_scan_unmatched'), value: String(scan.unmatched) },
          { label: $t('frameleaf_location_scan_skipped'), value: String(scan.skipped) },
          { label: $t('frameleaf_location_scan_failed_count'), value: String(scan.failed) },
        ]}
      />
      {#if scan.status === 'failed'}
        <div role="alert" class="message">{$t('frameleaf_location_scan_run_failed')}</div>
      {/if}
      {#if active}
        <div class="actions">
          <Button disabled={busy} onclick={cancel}>{$t('frameleaf_location_scan_cancel')}</Button>
        </div>
      {/if}
    {/if}
    {#if response && !response.available}
      <Notice>{$t('frameleaf_location_scan_unavailable')}</Notice>
    {:else if response?.enabled && response.available && !active}
      <div class="choices">
        <p>{$t('frameleaf_location_scan_disclosure')}</p>
        <p>{$t('frameleaf_location_scan_inference')}</p>
        <label
          ><input type="checkbox" bind:checked={refresh} disabled={busy} />{$t(
            'frameleaf_location_scan_refresh',
          )}</label
        >
        <label
          ><input type="checkbox" bind:checked={consent} disabled={busy} />{$t(
            'frameleaf_location_scan_consent',
          )}</label
        >
        <div class="actions">
          <Button variant="primary" disabled={!consent || busy || !!failure} onclick={start}>
            {$t('frameleaf_location_scan_title')}
          </Button>
        </div>
      </div>
    {/if}
    {#if failure}
      <InlineError
        message={$t(
          failure === 'load'
            ? 'frameleaf_location_scan_load_failed'
            : failure === 'start'
              ? 'frameleaf_location_scan_start_failed'
              : 'frameleaf_location_scan_cancel_failed',
        )}
        onRetry={failure === 'cancel' ? cancel : load}
        retryLabel={failure === 'start' ? $t('frameleaf_location_scan_check_status') : undefined}
        retrying={busy || reading}
        compact
      />
    {/if}
  </Section>
{/if}

<style>
  .choices,
  .progress {
    display: grid;
    gap: var(--fl-space-3);
    margin-bottom: var(--fl-space-4);
    font-size: var(--fl-font-callout);
  }
  p {
    margin: 0;
    color: var(--fl-muted);
    line-height: 1.5;
  }
  label {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 44px;
    line-height: 1.5;
  }
  input {
    flex-shrink: 0;
    width: 1rem;
    height: 1rem;
    min-height: 0;
    accent-color: var(--fl-accent);
  }
  progress {
    width: 100%;
    margin-bottom: var(--fl-space-4);
    accent-color: var(--fl-accent);
  }
  .actions,
  .message {
    margin-bottom: var(--fl-space-4);
  }
  .message {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  @media (pointer: coarse) {
    label {
      min-height: 48px;
    }
  }
</style>
