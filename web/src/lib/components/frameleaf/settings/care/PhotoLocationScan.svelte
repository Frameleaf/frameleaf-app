<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { formatUsd } from '$lib/frameleaf/cloud-ml';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
  import {
    cancelLocationScan,
    estimateLocationScan,
    getLocationScanStatus,
    startLocationScan,
    type LocationScanEstimateResponseDto,
    type LocationScanStatusResponseDto,
  } from '@frameleaf/sdk';
  import { onDestroy, untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';

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
  const billingKeys = {
    pending_hold: 'frameleaf_location_scan_billing_pending',
    held: 'frameleaf_location_scan_billing_held',
    settling: 'frameleaf_location_scan_billing_settling',
    settled: 'frameleaf_location_scan_billing_settled',
    released: 'frameleaf_location_scan_billing_released',
    no_charge: 'frameleaf_location_scan_billing_no_charge',
  } as const;

  /**
   * The server says why a scan paused in its own words; a person sees one of these sentences
   * instead, and anything not listed gets a general one, never the raw text.
   */
  const PAUSES = [
    [/request allowance/i, 'frameleaf_location_scan_pause_busy'],
    [/temporarily unavailable/i, 'frameleaf_location_scan_pause_unavailable'],
    // waits for a fix on Frameleaf Cloud's side and never restarts by itself
    [/provider-rejected/i, 'frameleaf_location_scan_pause_rejected'],
  ] as const;
  const pauseReason = (serverText: string) =>
    PAUSES.find(([pattern]) => pattern.test(serverText))?.[1] ?? 'frameleaf_location_scan_pause_other';

  let response = $state<LocationScanStatusResponseDto>();
  let quote = $state<LocationScanEstimateResponseDto | null>(null);
  let quoteOpen = $state(false);
  let quoteExpired = $state(false);
  let consent = $state(false);
  let refresh = $state(false);
  let limitMode = $state('spend');
  let spendLimit = $state<number | undefined>(5);
  let photoLimit = $state<number | undefined>(1000);
  let busy = $state(false);
  let estimating = $state(false);
  let reading = $state(false);
  let failure = $state<'load' | 'estimate' | 'start' | 'cancel' | null>(null);
  const accountId = $derived(authManager.authenticated && !authManager.isSharedLink ? authManager.user.id : null);
  const scan = $derived(response?.scan);
  const active = $derived(!!scan && ['queued', 'preparing', 'uploading', 'running', 'paused'].includes(scan.status));
  const billingFinal = $derived(!!scan?.billing && ['settled', 'released', 'no_charge'].includes(scan.billing.state));
  const spendMicros = $derived(Math.round((spendLimit ?? 0) * 1_000_000));
  // A spending limit is whole cents: at least one, and never rounded.
  const validLimit = $derived(
    limitMode === 'spend'
      ? Number.isSafeInteger(spendMicros) &&
          spendMicros >= 10_000 &&
          spendLimit !== undefined &&
          spendLimit === Number(spendLimit.toFixed(2))
      : photoLimit !== undefined && Number.isSafeInteger(photoLimit) && photoLimit > 0,
  );

  let generation = 0;
  let revision = 0;
  let quoteTurn = 0;
  let alive = true;
  onDestroy(() => {
    alive = false;
  });
  const captureView = () => {
    const owner = generation;
    const isCurrentSession = authManager.captureSession();
    return () => alive && owner === generation && isCurrentSession();
  };

  const invalidateQuote = () => {
    quoteTurn++;
    quote = null;
    quoteOpen = false;
    quoteExpired = false;
    consent = false;
    estimating = false;
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
    const account = accountId;
    generation++;
    revision++;
    response = undefined;
    refresh = false;
    limitMode = 'spend';
    spendLimit = 5;
    photoLimit = 1000;
    failure = null;
    busy = false;
    reading = false;
    untrack(() => {
      invalidateQuote();
      if (account) {
        void load();
      }
    });
  });

  $effect(() => {
    if (!scan || (!active && billingFinal) || busy || reading || failure) {
      return;
    }
    const timer = setTimeout(() => void load(), 10_000);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!quote?.expiresAt) {
      return;
    }
    const remaining = Date.parse(quote.expiresAt) - Date.now();
    const expire = () => {
      quoteExpired = true;
      consent = false;
    };
    if (!Number.isFinite(remaining) || remaining <= 0) {
      expire();
      return;
    }
    const timer = setTimeout(expire, remaining);
    return () => clearTimeout(timer);
  });

  const estimate = async () => {
    if (!validLimit || active || busy || failure === 'start' || failure === 'load') {
      return;
    }
    const isCurrent = captureView();
    const turn = ++quoteTurn;
    quote = null;
    consent = false;
    quoteExpired = false;
    estimating = true;
    failure = null;
    try {
      const next = await estimateLocationScan({
        locationScanEstimateRequestDto: {
          refresh,
          ...(limitMode === 'spend' ? { maxSpendMicros: spendMicros } : { maxPhotos: photoLimit }),
        },
      });
      if (isCurrent() && turn === quoteTurn) {
        quote = next;
        quoteOpen = true;
      }
    } catch {
      if (isCurrent() && turn === quoteTurn) {
        quoteOpen = false;
        failure = 'estimate';
      }
    } finally {
      if (isCurrent() && turn === quoteTurn) {
        estimating = false;
      }
    }
  };

  const start = async () => {
    if (!quote?.canStart || !quote.estimateId || !quote.expiresAt || !consent || quoteExpired || active || busy) {
      return;
    }
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      quoteExpired = true;
      consent = false;
      return;
    }
    const isCurrent = captureView();
    const estimateId = quote.estimateId;
    consent = false;
    refresh = false;
    busy = true;
    reading = false;
    revision++;
    try {
      const next = await startLocationScan({ startLocationScanDto: { estimateId, consent: true } });
      if (isCurrent()) {
        response = next;
        invalidateQuote();
        failure = null;
      }
    } catch {
      if (isCurrent()) {
        invalidateQuote();
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

{#if accountId}
  <!-- Its own page now (prototype `care/location-scan.jsx`): the page heading names it, so the card says
       what to do here. -->
  <Section
    title={$t(
      active
        ? 'frameleaf_location_scan_section_running'
        : scan
          ? 'frameleaf_location_scan_section_more'
          : 'frameleaf_location_scan_section_choose',
    )}
    description={active ? $t('frameleaf_location_scan_description') : $t('frameleaf_location_scan_section_free')}
  >
    {#if scan}
      <div class="progress" role="status">
        <strong>{$t(statusKeys[scan.status])}</strong>
        <span
          >{$t('frameleaf_location_scan_progress', { values: { processed: scan.processed, total: scan.total } })}</span
        >
        {#if scan.status === 'paused' && scan.reason}<span>{$t(pauseReason(scan.reason))}</span>{/if}
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
      {#if scan.billing}
        {@const receipt = scan.billing}
        <p class="message" role="status">{$t(billingKeys[receipt.state])}</p>
        <Facts
          rows={[
            { label: $t('frameleaf_location_scan_reserved'), value: formatUsd(receipt.heldMicros / 1_000_000) },
            { label: $t('frameleaf_location_scan_checked'), value: String(receipt.checkedPhotos) },
            ...(billingFinal && receipt.chargedMicros !== null
              ? [{ label: $t('frameleaf_location_scan_charged'), value: formatUsd(receipt.chargedMicros / 1_000_000) }]
              : []),
            ...(billingFinal && receipt.releasedMicros !== null
              ? [
                  {
                    label: $t('frameleaf_location_scan_credit_released'),
                    value: formatUsd(receipt.releasedMicros / 1_000_000),
                  },
                ]
              : []),
          ]}
        />
      {:else}<p class="message" role="status">{$t('frameleaf_location_scan_receipt_pending')}</p>{/if}
      {#if scan.status === 'failed'}
        <div role="alert" class="message">{$t('frameleaf_location_scan_run_failed')}</div>
      {/if}
      {#if active}
        <div class="actions">
          <Button disabled={busy} onclick={cancel}>{$t('frameleaf_location_scan_cancel')}</Button>
        </div>
        <p class="message">{$t('frameleaf_location_scan_cancel_billing')}</p>
      {/if}
    {/if}
    {#if !active}
      <div class="choices">
        {#if response && !response.available}<Notice>{$t('frameleaf_location_scan_unavailable')}</Notice>{/if}
        <SegmentedControl
          label={$t('frameleaf_location_scan_limit_by')}
          bind:value={limitMode}
          options={[
            { value: 'spend', label: $t('frameleaf_location_scan_spend_limit') },
            { value: 'photos', label: $t('frameleaf_location_scan_photo_limit') },
          ]}
          disabled={busy}
          onChange={invalidateQuote}
        />
        {#if limitMode === 'spend'}
          <label class="number-field"
            >{$t('frameleaf_location_scan_max_spend')}
            <span class="unit">
              <input
                type="number"
                aria-label={$t('frameleaf_location_scan_max_spend')}
                min="0.01"
                step="0.01"
                bind:value={spendLimit}
                disabled={busy}
                oninput={invalidateQuote}
              />
              <span>{$t('frameleaf_location_scan_max_spend_unit')}</span>
            </span>
          </label>
        {:else}
          <label class="number-field"
            >{$t('frameleaf_location_scan_max_photos')}
            <input type="number" min="1" step="1" bind:value={photoLimit} disabled={busy} oninput={invalidateQuote} />
          </label>
        {/if}
        <label
          ><input type="checkbox" bind:checked={refresh} disabled={busy} onchange={invalidateQuote} />{$t(
            'frameleaf_location_scan_refresh',
          )}</label
        >
        <div class="actions">
          <Button
            variant="primary"
            disabled={!response || !validLimit || estimating || busy || failure === 'start' || failure === 'load'}
            onclick={estimate}
          >
            {estimating ? $t('frameleaf_location_scan_estimating') : $t('frameleaf_location_scan_estimate')}
          </Button>
        </div>
      </div>
    {/if}
    {#if failure}
      <InlineError
        message={$t(
          failure === 'load'
            ? 'frameleaf_location_scan_load_failed'
            : failure === 'estimate'
              ? 'frameleaf_location_scan_estimate_failed'
              : failure === 'start'
                ? 'frameleaf_location_scan_start_failed'
                : 'frameleaf_location_scan_cancel_failed',
        )}
        onRetry={failure === 'cancel' ? cancel : failure === 'estimate' ? estimate : load}
        retryLabel={failure === 'start' ? $t('frameleaf_location_scan_check_status') : undefined}
        retrying={busy || reading || estimating}
        compact
      />
    {/if}
  </Section>

  <Dialog
    open={quoteOpen}
    title={$t('frameleaf_location_scan_review')}
    closeLabel={$t('close')}
    onRequestClose={invalidateQuote}
    size="medium"
  >
    {#if estimating}<p role="status">{$t('frameleaf_location_scan_estimating')}</p>{/if}
    {#if quote}
      <Facts
        rows={[
          { label: $t('frameleaf_location_scan_eligible'), value: String(quote.eligiblePhotos) },
          {
            label: $t('frameleaf_location_scan_library_cost'),
            value: formatUsd((quote.eligiblePhotos * quote.unitPriceMicros) / 1_000_000),
          },
          { label: $t('frameleaf_location_scan_selected'), value: String(quote.selectedPhotos) },
          { label: $t('frameleaf_location_scan_remaining'), value: String(quote.remainingPhotos) },
          { label: $t('frameleaf_location_scan_estimated_cost'), value: formatUsd(quote.estimatedMicros / 1_000_000) },
          { label: $t('frameleaf_location_scan_max_hold'), value: formatUsd(quote.holdMicros / 1_000_000) },
          {
            label: $t('frameleaf_location_scan_available_credit'),
            value: formatUsd(quote.availableMicros === null ? null : quote.availableMicros / 1_000_000),
          },
        ]}
      />
      <div class="choices">
        <p>
          {$t('frameleaf_location_scan_rate', {
            values: { amount: formatUsd((quote.unitPriceMicros * 1000) / 1_000_000) },
          })}
        </p>
        <p>{$t('frameleaf_location_scan_charge_basis')}</p>
        <p>{$t('frameleaf_location_scan_disclosure')}</p>
        <p>{$t('frameleaf_location_scan_inference')}</p>
        {#if quote.expiresAt}<p>
            {$t('frameleaf_location_scan_expires', {
              values: {
                time: new Date(quote.expiresAt).toLocaleTimeString($locale ?? undefined, { timeStyle: 'short' }),
              },
            })}
          </p>{/if}
        {#if quoteExpired}<Notice>{$t('frameleaf_location_scan_expired')}</Notice>{/if}
        {#if quote.refusal}<p role="alert">{quote.refusal}</p>{/if}
        {#if quote.canStart && quote.estimateId && quote.expiresAt}
          <label class="consent">
            <input type="checkbox" bind:checked={consent} disabled={busy || quoteExpired} />
            <span>
              <strong>{$t('frameleaf_location_scan_consent')}</strong>
              <small>
                {$t('frameleaf_location_scan_consent_detail', {
                  values: { amount: formatUsd(quote.holdMicros / 1_000_000) },
                })}
              </small>
            </span>
          </label>
        {/if}
      </div>
    {/if}
    {#snippet actions()}
      <Button disabled={busy} onclick={invalidateQuote}>{$t('cancel')}</Button>
      {#if quote?.topUpUrl && !quote.canStart}
        <Button
          variant="primary"
          onclick={() => {
            const topUpUrl = quote?.topUpUrl;
            invalidateQuote();
            getCloudManager.open('processing', { topUpUrl });
          }}
        >
          {$t('frameleaf_add_ai_credit')}
        </Button>
      {/if}
      {#if quoteExpired}<Button disabled={estimating || busy} onclick={estimate}
          >{$t('frameleaf_location_scan_estimate_again')}</Button
        >{/if}
      {#if quote?.canStart && quote.estimateId && quote.expiresAt}
        <Button variant="primary" disabled={!consent || quoteExpired || busy || estimating} onclick={start}>
          {$t('frameleaf_location_scan_start_reserve', { values: { amount: formatUsd(quote.holdMicros / 1_000_000) } })}
        </Button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  /* Controls keep their own width (the segmented choice is not stretched across the card). */
  .choices {
    justify-items: start;
  }
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
  input[type='checkbox'] {
    flex-shrink: 0;
    width: 1rem;
    height: 1rem;
    min-height: 0;
    accent-color: var(--fl-accent);
  }
  .number-field {
    display: grid;
    width: min(20rem, 100%);
  }
  .number-field .unit {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-muted);
  }
  .number-field input {
    width: 100%;
  }
  .consent {
    align-items: flex-start;
  }
  .consent input {
    margin-top: 0.25rem;
  }
  .consent span {
    display: grid;
    gap: var(--fl-space-1);
  }
  .consent small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
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
