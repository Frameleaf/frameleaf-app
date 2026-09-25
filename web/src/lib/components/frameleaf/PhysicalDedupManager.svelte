<script lang="ts">
  /**
   * Physical deduplication preview, review and apply (FL-71, FL-73), ported from the design
   * template's `PhysicalDedupManager.jsx`. The template kept a sample plan in localStorage; this
   * page reads the server's dry-run result (`getPhysicalDeduplicationPreview`), prepares a new one
   * through `requestPhysicalDeduplicationPreview`, has the server check the plan against the
   * library again when it is marked reviewed (`reviewPhysicalDeduplicationPlan`), and applies
   * exactly that reviewed plan as a durable job (`applyPhysicalDeduplicationPlan`).
   *
   * Rules carried over from the server contract:
   * - A preview may retain originals in an account chosen here when none is saved.
   * - Applying always uses the saved `physicalDeduplication.masterUserId`; the server refuses
   *   otherwise, and the page mirrors that refusal before offering the action.
   * - Each group can be left as it is. The review binds those decisions to the plan, and changing a
   *   decision after the review asks for a new review.
   * - Anything that changed since the preview is refused (409); the page then shows the current
   *   state instead of applying something nobody reviewed.
   * - Thumbnails are the requester's own asset access (`canView`), never widened by admin rights.
   *   Another account's Locked copies are counted, never listed.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import PhysicalDedupThumb from '$lib/components/frameleaf/PhysicalDedupThumb.svelte';
  import Picker from '$lib/components/frameleaf/Picker.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import {
    applyBlockedReason,
    applyForPlan,
    applyStatusKey,
    blocksReview,
    checksumAlgorithmKey,
    confirmationPhrase,
    DEDUP_SCOPE_ALL,
    formatBytes,
    groupPlanCopies,
    isApplyActive,
    isDecidableGroup,
    matchesConfirmation,
    normalizeExcluded,
    planMetrics,
    planSelection,
    planStaleReason,
    reviewExport,
    reviewMatches,
    skipReasonKey,
  } from '$lib/frameleaf/physical-dedup';
  import { OpenQueryParam } from '$lib/constants';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import {
    applyPhysicalDeduplicationPlan,
    cancelMediaOperation,
    getPhysicalDeduplicationPreview,
    isHttpError,
    MediaOperationStatus,
    pauseMediaOperation,
    PhysicalDeduplicationDecision,
    PhysicalDeduplicationPlanMode,
    requestPhysicalDeduplicationPreview,
    resumeMediaOperation,
    reviewPhysicalDeduplicationPlan,
    type PhysicalDeduplicationApplyDto,
    type PhysicalDeduplicationPreviewResponseDto,
    type PhysicalDeduplicationReviewResponseDto,
    type UserAdminResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiCheckCircleOutline,
    mdiCompare,
    mdiDownload,
    mdiFolderSearchOutline,
    mdiHelpCircleOutline,
    mdiHistory,
    mdiLinkVariant,
    mdiLinkVariantOff,
    mdiLockOutline,
    mdiMinusCircleOutline,
    mdiShieldCheckOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { t } from 'svelte-i18n';

  let {
    users,
    initial,
  }: {
    users: UserAdminResponseDto[];
    initial: PhysicalDeduplicationPreviewResponseDto;
  } = $props();

  let preview = $state(initial);
  let scope = $state(DEDUP_SCOPE_ALL);
  let previewMaster = $state<string | undefined>(initial.savedMasterUserId ?? users[0]?.id);
  let view = $state<'media' | 'table'>('media');
  /** Retained originals whose group the administrator decided to leave as it is. */
  const excluded = new SvelteSet<string>();
  let review = $state<PhysicalDeduplicationReviewResponseDto | null>(null);
  let confirmOpen = $state(false);
  let confirmation = $state('');
  let notice = $state('');
  let conflict = $state('');
  let busy = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const plan = $derived(preview.plan);
  const masterSaved = $derived(!!preview.savedMasterUserId);
  const effectiveMaster = $derived(preview.savedMasterUserId ?? previewMaster ?? null);
  const nameOf = (id: string | null | undefined) => users.find((user) => user.id === id)?.name ?? id ?? '';
  const scopeOptions = $derived([
    { label: $t('frameleaf_dedup_scope_all'), value: DEDUP_SCOPE_ALL },
    ...users.filter((user) => user.id !== effectiveMaster).map((user) => ({ label: user.name, value: user.id })),
  ]);
  // The template lists retained accounts by name (`PhysicalDedupManager.jsx:519-531`).
  const masterOptions = $derived(users.map((user) => ({ label: user.name, value: user.id })));
  const groups = $derived(plan ? groupPlanCopies(plan) : []);
  const metrics = $derived(plan ? planMetrics(plan) : null);
  const selection = $derived(plan ? planSelection(plan, excluded) : null);
  const stale = $derived(plan ? planStaleReason(plan, { scope, masterUserId: effectiveMaster }) : null);
  /** The newest job applying the plan on screen. */
  const planApply = $derived(applyForPlan(preview.applies, plan));
  /** Whichever job is applying a plan right now, this one or another administrator's. */
  const activeApply = $derived(preview.applies.find((apply) => isApplyActive(apply)) ?? null);
  const applied = $derived(planApply?.status === MediaOperationStatus.Completed);
  const applyBlocked = $derived(
    plan
      ? applyBlockedReason({
          plan,
          enabled: preview.enabled,
          savedMasterUserId: preview.savedMasterUserId,
          running: preview.running,
          applying: preview.applying,
          applied,
          selectedCopies: selection?.copies ?? 0,
        })
      : null,
  );
  const reviewBlocked = $derived(blocksReview(applyBlocked));
  /**
   * Decisions stay open while no copy is selected, so leaving every group out can be undone; they
   * only lock while a preview is prepared or a plan is being or has been applied.
   */
  const decisionsLocked = $derived(['running', 'applying', 'applied'].includes(applyBlocked ?? ''));
  const reviewed = $derived(reviewMatches(review, plan, excluded));
  const canConfirm = $derived(
    !!plan && reviewed && !stale && !applyBlocked && !busy && matchesConfirmation(plan, confirmation),
  );

  const time = (value: string) => DateTime.fromISO(value).toLocaleString(DateTime.DATETIME_MED);

  const refresh = async () => {
    try {
      const next = await getPhysicalDeduplicationPreview();
      const arrived = next.plan?.fingerprint !== preview.plan?.fingerprint;
      const wasApplying = preview.applying;
      preview = next;
      if (arrived) {
        excluded.clear();
        review = null;
        if (next.plan) {
          notice = $t('frameleaf_dedup_notice_preview_ready');
          view = 'media';
        }
      }
      if (wasApplying && !next.applying) {
        const finished = applyForPlan(next.applies, next.plan);
        if (finished?.status === MediaOperationStatus.Completed) {
          notice = $t('frameleaf_dedup_notice_applied');
        }
      }
      if (!next.running && !next.applying) {
        stopPolling();
      }
    } catch (error) {
      stopPolling();
      handleError(error, $t('frameleaf_dedup_unable_to_load'));
    }
  };

  const startPolling = () => {
    stopPolling();
    pollTimer = setInterval(() => void refresh(), 2000);
  };

  const stopPolling = () => {
    if (!pollTimer) {
      return;
    }

    clearInterval(pollTimer);
    pollTimer = undefined;
  };

  onDestroy(stopPolling);

  if (initial.running || initial.applying) {
    startPolling();
  }

  /** A 409 means the plan on screen no longer describes the library; show what is true now. */
  const handleConflict = async (error: unknown, fallback: string) => {
    if (isHttpError(error) && error.status === 409) {
      review = null;
      confirmOpen = false;
      conflict = $t('frameleaf_dedup_conflict');
      await refresh();
      if (preview.applying) {
        startPolling();
      }
      return;
    }
    handleError(error, fallback);
  };

  const prepare = async () => {
    if (!effectiveMaster) {
      return;
    }
    busy = true;
    try {
      await requestPhysicalDeduplicationPreview({
        physicalDeduplicationPreviewRequestDto: {
          masterUserId: masterSaved ? undefined : effectiveMaster,
          scopeUserId: scope === DEDUP_SCOPE_ALL ? undefined : scope,
        },
      });
      review = null;
      excluded.clear();
      confirmation = '';
      notice = '';
      conflict = '';
      preview = { ...preview, running: true };
      startPolling();
    } catch (error) {
      handleError(error, $t('frameleaf_dedup_unable_to_prepare'));
    } finally {
      busy = false;
    }
  };

  const toggleGroup = (retainedAssetId: string) => {
    if (excluded.has(retainedAssetId)) {
      excluded.delete(retainedAssetId);
    } else {
      excluded.add(retainedAssetId);
    }
    confirmation = '';
  };

  const markReviewed = async () => {
    if (!plan) {
      return;
    }
    busy = true;
    conflict = '';
    try {
      review = await reviewPhysicalDeduplicationPlan({
        physicalDeduplicationReviewRequestDto: {
          fingerprint: plan.fingerprint,
          excludedRetainedAssetIds: normalizeExcluded(excluded),
        },
      });
      notice = $t('frameleaf_dedup_notice_reviewed', { values: { plan: plan.planId } });
    } catch (error) {
      await handleConflict(error, $t('frameleaf_dedup_unable_to_review'));
    } finally {
      busy = false;
    }
  };

  const apply = async () => {
    if (!plan || !review || !canConfirm) {
      return;
    }
    busy = true;
    conflict = '';
    try {
      await applyPhysicalDeduplicationPlan({
        physicalDeduplicationApplyRequestDto: {
          fingerprint: plan.fingerprint,
          reviewToken: review.reviewToken,
          excludedRetainedAssetIds: review.excludedRetainedAssetIds,
          confirmation: confirmation.trim(),
        },
      });
      confirmOpen = false;
      confirmation = '';
      notice = $t('frameleaf_dedup_notice_applying', { values: { plan: plan.planId } });
      preview = { ...preview, applying: true };
      await refresh();
      startPolling();
    } catch (error) {
      await handleConflict(error, $t('frameleaf_dedup_unable_to_apply'));
    } finally {
      busy = false;
    }
  };

  const control = async (job: PhysicalDeduplicationApplyDto, action: 'pause' | 'resume' | 'cancel') => {
    busy = true;
    try {
      const id = job.operationId;
      await (action === 'pause'
        ? pauseMediaOperation({ id })
        : action === 'resume'
          ? resumeMediaOperation({ id })
          : cancelMediaOperation({ id }));
      await refresh();
      startPolling();
    } catch (error) {
      handleError(error, $t('frameleaf_dedup_unable_to_control'));
    } finally {
      busy = false;
    }
  };

  const exportReview = () => {
    if (!plan) {
      return;
    }
    const url = URL.createObjectURL(
      new Blob([reviewExport(plan, excluded, reviewed ? review : null)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `frameleaf-deduplication-${plan.planId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const blockedMessage = $derived.by(() => {
    switch (applyBlocked) {
      case 'running': {
        return $t('frameleaf_dedup_apply_blocked_running');
      }
      case 'applying': {
        return $t('frameleaf_dedup_apply_blocked_applying');
      }
      case 'applied': {
        return $t('frameleaf_dedup_apply_blocked_applied');
      }
      case 'disabled': {
        return $t('frameleaf_dedup_apply_blocked_disabled');
      }
      case 'no-saved-master': {
        return $t('frameleaf_dedup_apply_blocked_no_saved_master');
      }
      case 'master-mismatch': {
        return $t('frameleaf_dedup_apply_blocked_master_mismatch', { values: { name: plan?.masterUserName ?? '' } });
      }
      case 'no-shares': {
        return $t('frameleaf_dedup_apply_blocked_no_shares');
      }
      default: {
        return '';
      }
    }
  });

  const staleMessage = $derived(
    stale === 'scope'
      ? $t('frameleaf_dedup_stale_scope')
      : stale === 'master'
        ? $t('frameleaf_dedup_stale_master')
        : '',
  );

  const planBadge = $derived.by(() => {
    if (planApply && isApplyActive(planApply)) {
      return { label: $t('frameleaf_dedup_plan_applying'), tone: 'blue' as const };
    }
    if (applied) {
      return { label: $t('frameleaf_dedup_plan_applied'), tone: 'teal' as const };
    }
    if (plan?.mode === PhysicalDeduplicationPlanMode.Apply) {
      // Its job stopped or failed after changing some files; the rest need a new plan.
      return { label: $t('frameleaf_dedup_plan_partly_applied'), tone: 'warning' as const };
    }
    if (reviewed) {
      return { label: $t('frameleaf_dedup_plan_reviewed'), tone: 'blue' as const };
    }
    return { label: $t('frameleaf_dedup_plan_preview'), tone: 'blue' as const };
  });

  const settingsHref = Route.systemSettings({ isOpen: OpenQueryParam.STORAGE_TEMPLATE });

  /**
   * FL-71 UT-23: the template's `dedupConfigurationError` (`physical-dedup-data.mjs:76-86`). File
   * reuse must be on, and an account must hold the retained originals (the saved one, or the one
   * chosen here for a preview), before a plan can be prepared; the page says which and offers
   * "Open settings" with Prepare disabled.
   */
  const configError = $derived(
    preview.enabled
      ? effectiveMaster
        ? ''
        : $t('frameleaf_dedup_config_error_no_account')
      : $t('frameleaf_dedup_config_error_disabled'),
  );
</script>

<div class="dedup">
  <div class="toolbar">
    <div class="toolbar-field">
      <Picker
        label={$t('frameleaf_dedup_scan_scope')}
        options={scopeOptions}
        selectedOption={scopeOptions.find((option) => option.value === scope)}
        disabled={preview.running}
        onSelect={(option) => {
          scope = option?.value ?? DEDUP_SCOPE_ALL;
          confirmation = '';
        }}
      />
    </div>
    {#if masterSaved}
      <div class="retained-saved">
        <span>{$t('frameleaf_dedup_retain_in')}</span>
        <strong>{nameOf(preview.savedMasterUserId)}</strong>
        <a class="button" href={settingsHref}>{$t('frameleaf_dedup_retained_change')}</a>
      </div>
    {:else}
      <div class="toolbar-field">
        <Picker
          label={$t('frameleaf_dedup_retain_in')}
          options={masterOptions}
          selectedOption={masterOptions.find((option) => option.value === previewMaster)}
          disabled={preview.running}
          onSelect={(option) => {
            previewMaster = option?.value;
            confirmation = '';
          }}
        />
      </div>
    {/if}
    <div class="toolbar-actions">
      <Button variant="primary" disabled={!!configError || preview.running || busy} onclick={prepare}>
        <Icon icon={mdiFolderSearchOutline} size="1em" aria-hidden={true} />
        {plan ? $t('frameleaf_dedup_prepare_new') : $t('frameleaf_dedup_prepare')}
      </Button>
    </div>
  </div>

  <p class="scope-note">
    {scope === DEDUP_SCOPE_ALL
      ? $t('frameleaf_dedup_scope_all_body')
      : $t('frameleaf_dedup_scope_one_body', { values: { name: nameOf(scope) } })}
    {#if !masterSaved}
      <FormatMessage key="frameleaf_dedup_preview_uses_chosen">
        {#snippet children({ tag, message })}
          {#if tag === 'link'}
            <a href={settingsHref}>{message}</a>
          {:else}
            {message}
          {/if}
        {/snippet}
      </FormatMessage>
    {/if}
  </p>

  {#if configError}
    <p class="message error config-error" role="status">
      <span>{configError}</span>
      <a class="button" href={settingsHref}>{$t('frameleaf_dedup_open_settings')}</a>
    </p>
  {/if}

  {#if preview.running}
    <Status message={$t('frameleaf_dedup_plan_running')} busy />
  {:else if notice}
    <Status message={notice} />
  {/if}
  {#if conflict}
    <p class="message error" role="alert">{conflict}</p>
  {/if}

  {#if activeApply}
    {@const current = activeApply}
    <section class="apply-panel" aria-label={$t('frameleaf_dedup_apply_panel_label')}>
      <div class="apply-head">
        <div>
          <Badge value={$t(applyStatusKey(current))} label={$t(applyStatusKey(current))} tone="blue" />
          <strong>{current.planId}</strong>
          <small>
            {$t('frameleaf_dedup_apply_by', {
              values: { name: current.requestedByName, time: time(current.createdAt) },
            })}
          </small>
        </div>
        {#if current.mine}
          <div class="apply-buttons">
            {#if current.status === MediaOperationStatus.Paused || current.pauseRequested}
              <Button disabled={busy} onclick={() => control(current, 'resume')}>
                {$t('frameleaf_dedup_resume')}
              </Button>
            {:else if current.status !== MediaOperationStatus.Cancelling}
              <Button disabled={busy} onclick={() => control(current, 'pause')}>{$t('frameleaf_dedup_pause')}</Button>
            {/if}
            {#if current.status !== MediaOperationStatus.Cancelling}
              <Button disabled={busy} onclick={() => control(current, 'cancel')}>{$t('frameleaf_dedup_stop')}</Button>
            {/if}
          </div>
        {/if}
      </div>
      <progress
        aria-label={$t('frameleaf_dedup_apply_panel_label')}
        max={Math.max(current.total, 1)}
        value={current.processed}
      ></progress>
      <p class="apply-counts">
        {$t('frameleaf_dedup_apply_counts', {
          values: {
            processed: current.processed,
            total: current.total,
            applied: current.applied + current.alreadyApplied,
            skipped: current.skipped,
            failed: current.failed,
            bytes: formatBytes(current.reclaimedBytes),
          },
        })}
      </p>
      <p class="note">
        {current.mine ? $t('frameleaf_dedup_apply_activity') : $t('frameleaf_dedup_apply_other_admin')}
        <a href={Route.activity({ filter: 'running' })}>{$t('frameleaf_dedup_open_activity')}</a>
      </p>
    </section>
  {/if}

  {#if !plan}
    <Pane label={$t('admin.physical_deduplication')}>
      <div class="empty">
        <Icon icon={mdiCompare} size="2rem" aria-hidden={true} />
        <h2>{$t('frameleaf_dedup_empty_start_title')}</h2>
        <p>{$t('frameleaf_dedup_empty_start_body')}</p>
      </div>
    </Pane>
  {:else}
    <div class="plan-heading">
      <div>
        <Badge value={planBadge.label} label={planBadge.label} tone={planBadge.tone} />
        <h2>{plan.planId}</h2>
        <p>
          {$t('frameleaf_dedup_plan_meta', {
            values: {
              time: time(plan.ranAt),
              scope: plan.scopeUserId
                ? (plan.scopeUserName ?? nameOf(plan.scopeUserId))
                : $t('frameleaf_dedup_scope_all'),
              name: plan.masterUserName,
            },
          })}
        </p>
      </div>
      <div class="plan-tools">
        <SegmentedControl
          label={$t('frameleaf_dedup_view_label')}
          options={[
            { value: 'media', label: $t('frameleaf_dedup_view_media') },
            { value: 'table', label: $t('frameleaf_dedup_view_evidence') },
          ]}
          value={view}
          onChange={(next) => (view = next === 'table' ? 'table' : 'media')}
        />
        <Button onclick={exportReview}>
          <Icon icon={mdiDownload} size="1em" aria-hidden={true} />
          {$t('frameleaf_dedup_export')}
        </Button>
      </div>
    </div>

    {#if metrics}
      <div class="metrics">
        <div class="metric">
          <span>{$t('frameleaf_dedup_metric_copies')}</span><strong>{metrics.copiesToShare}</strong>
        </div>
        <div class="metric">
          <span>{$t('frameleaf_dedup_metric_retained')}</span><strong>{metrics.retainedOriginals}</strong>
        </div>
        <div class="metric">
          <span>{$t('frameleaf_dedup_metric_reclaim')}</span><strong>{formatBytes(metrics.reclaimableBytes)}</strong>
        </div>
        <div class="metric">
          <span>{$t('frameleaf_dedup_metric_skipped')}</span><strong>{metrics.skippedCopies}</strong>
        </div>
      </div>
    {/if}

    {#if staleMessage}
      <p class="message" role="status">{staleMessage}</p>
    {/if}
    {#if plan.copiesTruncated}
      <p class="message" role="status">
        {$t('frameleaf_dedup_truncated_applies', {
          values: { count: plan.copies.length, applicable: plan.applicableCopies },
        })}
      </p>
    {/if}
    {#if selection && selection.hiddenCopies > 0}
      <p class="message" role="status">
        <Icon icon={mdiLockOutline} size="1em" aria-hidden={true} />
        {$t('frameleaf_dedup_hidden_copies', { values: { count: selection.hiddenCopies } })}
      </p>
    {/if}

    {#if view === 'media'}
      <div class="groups">
        {#each groups as group (group.key)}
          {@const first = group.copies[0]}
          {@const decidable = isDecidableGroup(group)}
          {@const kept = !!group.retained && excluded.has(group.retained.assetId)}
          <article
            class="group"
            class:skipped={group.shares === 0 || kept}
            aria-label={group.retained
              ? $t('frameleaf_dedup_group_label', { values: { name: group.retained.originalFileName } })
              : $t('frameleaf_dedup_group_unmatched_label', { values: { name: first.originalFileName } })}
          >
            <div class="retained-side">
              {#if group.retained}
                <PhysicalDedupThumb
                  assetId={group.retained.assetId}
                  type={group.retained.type}
                  canView={group.retained.canView}
                  unavailable={!group.retained.fileAvailable}
                  size="retained"
                />
                <div class="retained-text">
                  <span class="pill retained">
                    <Icon icon={mdiShieldCheckOutline} size="0.8125rem" aria-hidden={true} />
                    {$t('frameleaf_dedup_retained_badge')}
                  </span>
                  <strong>{group.retained.originalFileName}</strong>
                  <small>{group.retained.ownerName} · {formatBytes(group.retained.sizeInBytes)}</small>
                  <small class="references">
                    <Icon icon={mdiLinkVariant} size="0.8125rem" aria-hidden={true} />
                    {$t('frameleaf_dedup_references_now', { values: { count: group.retained.referencesBefore } })}
                    {#if group.shares > 0 && !kept}
                      · {$t('frameleaf_dedup_references_after', {
                        values: { before: group.retained.referencesBefore, after: group.retained.referencesAfter },
                      })}
                    {/if}
                  </small>
                  {#if decidable}
                    <label class="group-decision">
                      <input
                        type="checkbox"
                        checked={!kept}
                        disabled={busy || decisionsLocked}
                        onchange={() => toggleGroup(group.retained!.assetId)}
                      />
                      <span>{$t('frameleaf_dedup_group_include')}</span>
                    </label>
                  {/if}
                  <details class="evidence">
                    <summary>{$t('frameleaf_dedup_location')}</summary>
                    <code>{group.retained.originalPath}</code>
                  </details>
                </div>
              {:else}
                <PhysicalDedupThumb assetId={first.assetId} type={first.type} canView={first.canView} size="retained" />
                <div class="retained-text">
                  <span class="pill">
                    <Icon icon={mdiHelpCircleOutline} size="0.8125rem" aria-hidden={true} />
                    {$t('frameleaf_dedup_no_exact_copy_in', { values: { name: plan.masterUserName } })}
                  </span>
                  <strong>{first.originalFileName}</strong>
                  <small>{$t('frameleaf_dedup_no_exact_copy_body', { values: { name: plan.masterUserName } })}</small>
                </div>
              {/if}
            </div>
            <div class="link" aria-hidden="true">
              <Icon icon={group.shares > 0 && !kept ? mdiLinkVariant : mdiLinkVariantOff} size="1.125rem" />
            </div>
            <ul class="copies" aria-label={$t('frameleaf_dedup_copies_label')}>
              {#each group.copies as copy (copy.assetId)}
                {@const shares = copy.decision === PhysicalDeduplicationDecision.Share && !kept}
                <li class="copy" class:skipped={!shares}>
                  <PhysicalDedupThumb assetId={copy.assetId} type={copy.type} canView={copy.canView} />
                  <div class="copy-text">
                    <strong>{$t('frameleaf_dedup_copy_of', { values: { name: copy.ownerName } })}</strong>
                    <small>{copy.originalFileName} · {formatBytes(copy.sizeInBytes)}</small>
                    <span class="decision" class:share={shares}>
                      <Icon
                        icon={shares ? mdiCheckCircleOutline : mdiMinusCircleOutline}
                        size="0.875rem"
                        aria-hidden={true}
                      />
                      {#if shares}
                        {$t('frameleaf_dedup_decision_share', { values: { size: formatBytes(copy.sizeInBytes) } })}
                      {:else if copy.decision === PhysicalDeduplicationDecision.Share}
                        {$t('frameleaf_dedup_decision_kept')}
                      {:else}
                        {$t('frameleaf_dedup_decision_skip', { values: { reason: $t(skipReasonKey(copy.reason)) } })}
                      {/if}
                    </span>
                    <details class="evidence">
                      <summary>{$t('frameleaf_dedup_evidence')}</summary>
                      <dl>
                        <div>
                          <dt>{$t('frameleaf_dedup_evidence_file')}</dt>
                          <dd><code>{copy.originalPath}</code></dd>
                        </div>
                        <div>
                          <dt>{$t(checksumAlgorithmKey(copy.checksum))}</dt>
                          <dd><code>{copy.checksum}</code></dd>
                        </div>
                        {#if group.retained}
                          <div>
                            <dt>{$t('frameleaf_dedup_evidence_retained')}</dt>
                            <dd>
                              <code>{group.retained.originalPath}</code>
                              <code>{group.retained.checksum}</code>
                            </dd>
                          </div>
                        {/if}
                        <div>
                          <dt>{$t('frameleaf_dedup_table_evidence')}</dt>
                          <dd>
                            {copy.checksumMatch
                              ? $t('frameleaf_dedup_evidence_match')
                              : $t('frameleaf_dedup_evidence_no_match')}
                          </dd>
                        </div>
                      </dl>
                    </details>
                  </div>
                </li>
              {/each}
            </ul>
          </article>
        {/each}
        {#if groups.length === 0}
          <div class="empty">{$t('frameleaf_dedup_empty_scope')}</div>
        {/if}
      </div>
    {:else}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">{$t('frameleaf_dedup_table_copy')}</th>
              <th scope="col">{$t('frameleaf_dedup_table_retained')}</th>
              <th scope="col">{$t('frameleaf_dedup_table_evidence')}</th>
              <th scope="col">{$t('frameleaf_dedup_table_references')}</th>
              <th scope="col">{$t('frameleaf_dedup_table_decision')}</th>
            </tr>
          </thead>
          <tbody>
            {#each plan.copies as copy (copy.assetId)}
              {@const retained = plan.retained.find((item) => item.assetId === copy.retainedAssetId)}
              {@const kept = !!copy.retainedAssetId && excluded.has(copy.retainedAssetId)}
              {@const shares = copy.decision === PhysicalDeduplicationDecision.Share && !kept}
              <tr>
                <th scope="row">
                  <span class="cell-media">
                    <PhysicalDedupThumb assetId={copy.assetId} type={copy.type} canView={copy.canView} size="cell" />
                    <span>
                      <strong>{copy.originalFileName}</strong>
                      <small>{copy.ownerName} · {formatBytes(copy.sizeInBytes)}</small>
                    </span>
                  </span>
                  <details>
                    <summary>{$t('frameleaf_dedup_location')}</summary>
                    <code>{copy.originalPath}</code>
                  </details>
                </th>
                <td>
                  {#if retained}
                    <strong>{retained.ownerName}</strong>
                    <small class:unavailable-text={!retained.fileAvailable}>
                      {retained.fileAvailable
                        ? $t('frameleaf_dedup_table_file_available')
                        : $t('frameleaf_dedup_table_file_unavailable')}
                    </small>
                    <details>
                      <summary>{$t('frameleaf_dedup_location')}</summary>
                      <code>{retained.originalPath}</code>
                    </details>
                  {:else}
                    <span class="muted">{$t('frameleaf_dedup_evidence_no_match')}</span>
                  {/if}
                </td>
                <td>
                  <span>
                    {copy.checksumMatch
                      ? $t('frameleaf_dedup_evidence_match')
                      : $t('frameleaf_dedup_evidence_no_match')}
                  </span>
                  <details>
                    <summary>{$t(checksumAlgorithmKey(copy.checksum))}</summary>
                    <code>{copy.checksum}</code>
                    {#if retained}
                      <small>{$t('frameleaf_dedup_evidence_retained')}</small>
                      <code>{retained.checksum}</code>
                    {/if}
                  </details>
                </td>
                <td>
                  {#if retained}
                    <strong>
                      {retained.referencesBefore} → {kept ? retained.referencesBefore : retained.referencesAfter}
                    </strong>
                  {:else}
                    <span class="muted">—</span>
                  {/if}
                </td>
                <td>
                  <strong class:share={shares}>
                    {#if shares}
                      {$t('frameleaf_dedup_decision_share', { values: { size: formatBytes(copy.sizeInBytes) } })}
                    {:else if copy.decision === PhysicalDeduplicationDecision.Share}
                      {$t('frameleaf_dedup_decision_kept')}
                    {:else}
                      {$t('frameleaf_dedup_decision_skip', { values: { reason: $t(skipReasonKey(copy.reason)) } })}
                    {/if}
                  </strong>
                </td>
              </tr>
            {/each}
            {#if plan.copies.length === 0}
              <tr><td colspan="5"><div class="empty">{$t('frameleaf_dedup_empty_scope')}</div></td></tr>
            {/if}
          </tbody>
        </table>
      </div>
    {/if}

    <p class="note">{$t('frameleaf_dedup_note')}</p>

    <div class="queue-actions">
      <div class="queue-note">
        <Icon icon={mdiShieldCheckOutline} size="1.125rem" aria-hidden={true} />
        <span>
          {#if selection && selection.keptGroups > 0 && !applyBlocked}
            {$t('frameleaf_dedup_selection', { values: { copies: selection.copies, kept: selection.keptGroups } })}
          {:else}
            {blockedMessage || $t('frameleaf_dedup_apply_requires')}
          {/if}
        </span>
      </div>
      <div class="queue-buttons">
        {#if applied || plan.mode === PhysicalDeduplicationPlanMode.Apply}
          <span class="done">
            <Icon icon={mdiCheckCircleOutline} size="1em" aria-hidden={true} />
            {$t('frameleaf_dedup_plan_recorded')}
          </span>
        {:else if !reviewed}
          <Button disabled={!!stale || reviewBlocked || busy} onclick={markReviewed}>
            {$t('frameleaf_dedup_mark_reviewed')}
          </Button>
        {:else}
          <Button
            variant="primary"
            disabled={!!stale || !!applyBlocked || busy}
            onclick={() => {
              confirmation = '';
              conflict = '';
              confirmOpen = true;
            }}
          >
            {$t('frameleaf_dedup_apply')}
          </Button>
        {/if}
      </div>
    </div>
  {/if}

  {#if preview.applies.length > 0}
    <details class="history">
      <summary>
        <Icon icon={mdiHistory} size="1.125rem" aria-hidden={true} />
        {$t('frameleaf_dedup_history')}
        <span class="count">{preview.applies.length}</span>
      </summary>
      <ol>
        {#each preview.applies as entry (entry.operationId)}
          <li>
            <div>
              <strong>{$t(applyStatusKey(entry))} · {entry.planId}</strong>
              <span>
                {$t('frameleaf_dedup_history_counts', {
                  values: {
                    applied: entry.applied + entry.alreadyApplied,
                    total: entry.total,
                    skipped: entry.skipped,
                    failed: entry.failed,
                    bytes: formatBytes(entry.reclaimedBytes),
                    name: entry.requestedByName,
                  },
                })}
              </span>
            </div>
            <time datetime={entry.finishedAt ?? entry.createdAt}>{time(entry.finishedAt ?? entry.createdAt)}</time>
          </li>
        {/each}
      </ol>
    </details>
  {/if}
</div>

<Dialog title={$t('frameleaf_dedup_confirm_title')} closeLabel={$t('close')} bind:open={confirmOpen}>
  {#if plan && review}
    <div class="confirm">
      <p>{$t('frameleaf_dedup_confirm_body')}</p>
      <dl>
        <div>
          <dt>{$t('frameleaf_dedup_confirm_plan')}</dt>
          <dd>{plan.planId}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_dedup_scan_scope')}</dt>
          <dd>
            {plan.scopeUserId ? (plan.scopeUserName ?? nameOf(plan.scopeUserId)) : $t('frameleaf_dedup_scope_all')}
          </dd>
        </div>
        <div>
          <dt>{$t('frameleaf_dedup_retain_in')}</dt>
          <dd>{plan.masterUserName}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_dedup_metric_copies')}</dt>
          <dd>{review.copies}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_dedup_confirm_estimate')}</dt>
          <dd>{formatBytes(review.estimatedBytes)}</dd>
        </div>
        {#if review.excludedRetainedAssetIds.length > 0}
          <div>
            <dt>{$t('frameleaf_dedup_confirm_kept')}</dt>
            <dd>{review.excludedRetainedAssetIds.length}</dd>
          </div>
        {/if}
      </dl>
      {#if review.hiddenCopies > 0}
        <p>{$t('frameleaf_dedup_hidden_copies', { values: { count: review.hiddenCopies } })}</p>
      {/if}
      <p>{$t('frameleaf_dedup_confirm_backup')}</p>
      <label>
        <span>{$t('frameleaf_dedup_confirm_label', { values: { phrase: confirmationPhrase(plan) } })}</span>
        <input type="text" autocomplete="off" spellcheck="false" maxlength="90" bind:value={confirmation} />
      </label>
      {#if conflict || blockedMessage || staleMessage}
        <p class="message" role="alert">{conflict || blockedMessage || staleMessage}</p>
      {/if}
      <div class="confirm-actions">
        <Button onclick={() => (confirmOpen = false)} disabled={busy}>{$t('cancel')}</Button>
        <Button variant="primary" disabled={!canConfirm} onclick={apply}>
          {$t('frameleaf_dedup_apply_confirm')}
        </Button>
      </div>
    </div>
  {/if}
</Dialog>

<style>
  .dedup {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    color: var(--fl-text);
  }
  .toolbar {
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .toolbar-field {
    min-width: 14rem;
    flex: 1 1 14rem;
  }
  .retained-saved {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    min-height: 2.75rem;
    justify-content: flex-end;
  }
  .retained-saved > span {
    font-size: var(--fl-font-micro);
    font-weight: 600;
    color: var(--fl-muted);
  }
  .retained-saved > strong {
    font-weight: 550;
  }
  .scope-note a {
    color: var(--fl-accent);
    text-decoration: underline;
  }
  .toolbar-actions {
    display: flex;
    gap: 0.5rem;
    margin-inline-start: auto;
  }
  .scope-note,
  .note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.6;
  }
  .message {
    margin: 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    font-size: var(--fl-font-small);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 2.75rem 1.25rem;
    text-align: center;
    color: var(--fl-muted);
  }
  .empty h2 {
    margin: 0;
    color: var(--fl-text);
    font-size: 1rem;
  }
  .empty p {
    margin: 0;
    max-width: 36rem;
    font-size: var(--fl-font-small);
  }
  .plan-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 1rem;
    padding-block-start: 1rem;
    border-block-start: 1px solid var(--fl-border);
  }
  .plan-heading h2 {
    margin: 0.3125rem 0 0.1875rem;
    font-size: 0.9375rem;
  }
  .plan-heading p {
    margin: 0;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .plan-tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: 0.625rem;
  }
  .metric {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .metric span {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .metric strong {
    font-size: 1.125rem;
  }
  .groups {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }
  .group {
    display: grid;
    grid-template-columns: minmax(12.5rem, 14rem) 2rem minmax(0, 1fr);
    align-items: start;
    gap: 0.5rem;
    padding: 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .group.skipped {
    opacity: 0.85;
  }
  .retained-side,
  .retained-text {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }
  .retained-text {
    gap: 0.25rem;
  }
  .retained-text strong {
    font-size: 0.875rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .retained-text small,
  .copy-text small {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
    overflow-wrap: anywhere;
  }
  .references {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    color: var(--fl-teal) !important;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 0.3125rem;
    min-height: 1.375rem;
    padding: 0 0.5rem;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-weight: 600;
  }
  .pill.retained {
    background: var(--fl-accent-soft);
    color: var(--fl-accent);
  }
  .link {
    display: grid;
    place-items: center;
    min-height: 4.5rem;
    color: var(--fl-muted);
  }
  .copies {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14.375rem, 1fr));
    gap: 0.625rem;
  }
  .copy {
    display: flex;
    gap: 0.625rem;
    min-width: 0;
    padding: 0.625rem;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .copy.skipped {
    opacity: 0.72;
  }
  .copy-text {
    display: flex;
    flex-direction: column;
    gap: 0.1875rem;
    min-width: 0;
  }
  .copy-text strong {
    font-size: 0.8125rem;
  }
  .decision {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    margin-block-start: 0.125rem;
    font-size: var(--fl-font-small);
    font-weight: 600;
    color: var(--fl-muted);
  }
  .decision.share,
  td strong.share {
    color: var(--fl-accent);
  }
  .evidence {
    margin-block-start: 0.25rem;
  }
  .evidence summary,
  table summary {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    cursor: pointer;
    min-height: 0;
  }
  .evidence dl {
    display: grid;
    gap: 0.375rem;
    margin: 0.5rem 0 0;
  }
  .evidence dl div {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .evidence dt {
    font-size: var(--fl-font-micro);
    font-weight: 600;
    color: var(--fl-muted);
  }
  .evidence dd {
    margin: 0;
  }
  code {
    display: block;
    font-size: 0.625rem;
    font-weight: 400;
    overflow-wrap: anywhere;
  }
  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fl-font-small);
  }
  th,
  td {
    padding: 0.625rem 0.75rem;
    text-align: start;
    vertical-align: top;
    border-block-end: 1px solid var(--fl-border);
  }
  thead th {
    font-size: var(--fl-font-micro);
    font-weight: 600;
    color: var(--fl-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  tbody th {
    min-width: 10rem;
    font-weight: 400;
  }
  table strong {
    display: block;
    font-weight: 550;
  }
  table small {
    display: block;
    margin: 0.25rem 0;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  table details {
    margin-block-start: 0.5rem;
    max-width: 14.375rem;
  }
  .cell-media {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }
  .cell-media > span {
    min-width: 0;
  }
  .muted {
    color: var(--fl-muted);
  }
  .queue-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .queue-note {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .queue-buttons {
    display: flex;
    gap: 0.5rem;
  }
  .confirm p {
    margin: 0 0 0.75rem;
  }
  .confirm dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.5rem;
    margin: 0 0 0.75rem;
  }
  .confirm dt {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .confirm dd {
    margin: 0;
    font-weight: 550;
  }
  .confirm label {
    display: flex;
    flex-direction: column;
    gap: 0.4375rem;
    margin-block: 1rem;
    font-size: var(--fl-font-small);
  }
  .confirm input {
    width: 100%;
    padding: 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .message.error {
    border-color: var(--fl-danger);
    color: var(--fl-danger-text);
  }
  /* The template's `.jm-message.jm-error` with its "Open settings" button (UT-23). */
  .config-error {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .unavailable-text {
    color: var(--fl-danger-text);
  }
  .message :global(svg) {
    vertical-align: -0.125em;
  }
  .group-decision {
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    margin-block-start: 0.25rem;
    font-size: var(--fl-font-small);
    cursor: pointer;
  }
  .group-decision input {
    width: 1rem;
    height: 1rem;
    accent-color: var(--fl-accent);
  }
  .apply-panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .apply-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .apply-head > div:first-child {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .apply-head small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .apply-buttons {
    display: flex;
    gap: 0.5rem;
  }
  .apply-panel progress {
    width: 100%;
    height: 0.375rem;
    accent-color: var(--fl-accent);
  }
  .apply-counts {
    margin: 0;
    font-size: var(--fl-font-small);
  }
  .apply-panel a {
    color: var(--fl-accent);
    text-decoration: underline;
  }
  .done {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--fl-teal);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .history {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .history summary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 0.875rem;
    font-size: var(--fl-font-small);
    font-weight: 600;
    cursor: pointer;
  }
  .history .count {
    color: var(--fl-muted);
    font-weight: 400;
  }
  .history ol {
    list-style: none;
    margin: 0;
    padding: 0 0.875rem 0.75rem;
  }
  .history li {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding-block: 0.5rem;
    border-block-start: 1px solid var(--fl-border);
  }
  .history li > div {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }
  .history li strong {
    font-size: var(--fl-font-small);
  }
  .history li span,
  .history time {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  @media (max-width: 56rem) {
    .group {
      grid-template-columns: 1fr;
    }
    .link {
      min-height: 1.5rem;
      transform: rotate(90deg);
    }
    .retained-side {
      flex-direction: row;
    }
    .retained-side :global(.thumb.retained) {
      width: 7.5rem;
      aspect-ratio: 1;
    }
  }
  @media (max-width: 44rem) {
    .toolbar-actions {
      width: 100%;
    }
    .copies {
      grid-template-columns: 1fr;
    }
  }
</style>
