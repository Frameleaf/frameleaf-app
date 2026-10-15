<script lang="ts">
  /**
   * Library care › Merge older copies (FL-71, FL-73; restyled for FL-366 after the approved prototype
   * `settings-v2/care/duplicates.jsx` `ExactCopies`). Exact copies added before Frameleaf began storing
   * identical files once: the page reads the server's last search (`getPhysicalDeduplicationPreview`),
   * looks again through `requestPhysicalDeduplicationPreview`, has the server check the list against
   * the library again when "I have checked this list" is ticked (`reviewPhysicalDeduplicationPlan`), and
   * merges exactly that checked list as a durable job (`applyPhysicalDeduplicationPlan`).
   *
   * Rules carried over from the server contract:
   * - The list keeps the shared file with the person chosen on this page ("Keep the shared file
   *   with"); the server checks that account still exists. There is no saved account elsewhere, so the
   *   page never sends anyone to another setting first.
   * - Each group can be left as it is. The check binds those decisions to the list, and changing a
   *   decision after the check asks for a new one.
   * - Anything that changed since the search is refused (409); the page then shows the current state
   *   instead of merging something nobody checked. Merging also needs the typed phrase.
   * - Pictures are the requester's own access (`canView`), never widened by admin rights. Another
   *   account's Locked copies are counted, never listed.
   * - The extra files move to File trash; the space comes back when it is emptied. The estimate, the
   *   byte counts and what a merge measurably removed sit apart in the closed Details (FL-73).
   * - A finished merge can be verified (FL-73): every kept file hashed again, every copy checked to
   *   resolve to it, with what can and cannot be undone said plainly.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PhysicalDedupThumb from '$lib/components/frameleaf/PhysicalDedupThumb.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import TypedConfirmation from '$lib/components/frameleaf/settings/TypedConfirmation.svelte';
  import { matchesTyped } from '$lib/components/frameleaf/settings/typed-confirmation';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import {
    applyBlockedReason,
    applyForPlan,
    applyStatusKey,
    blocksReview,
    canVerifyApply,
    checksumAlgorithmKey,
    confirmationPhrase,
    DEDUP_SCOPE_ALL,
    dedupConfigurationError,
    formatBytes,
    groupPlanCopies,
    isApplyActive,
    isDecidableGroup,
    mediaDetail,
    normalizeExcluded,
    planMetrics,
    planSelection,
    planStaleReason,
    reviewExport,
    reviewMatches,
    skipReasonKey,
    undoKey,
    verificationItemKey,
  } from '$lib/frameleaf/physical-dedup';
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
    restorePhysicalDeduplicationCopy,
    resumeMediaOperation,
    reviewPhysicalDeduplicationPlan,
    verifyPhysicalDeduplicationApply,
    type PhysicalDeduplicationApplyDto,
    type PhysicalDeduplicationPreviewResponseDto,
    type PhysicalDeduplicationReviewResponseDto,
    type PhysicalDeduplicationVerificationDto,
    type UserAdminResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheckCircleOutline,
    mdiContentCopy,
    mdiDownload,
    mdiHelpCircleOutline,
    mdiLinkVariant,
    mdiLinkVariantOff,
    mdiLockOutline,
    mdiMagnify,
    mdiMinusCircleOutline,
    mdiProgressClock,
    mdiShieldCheckOutline,
    mdiShieldSearch,
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
  /** The person whose folders keep the shared file: the one chosen here is the one used. */
  let keeper = $state<string | undefined>(initial.plan?.masterUserId ?? initial.savedMasterUserId ?? users[0]?.id);
  /** Kept files whose group the administrator decided to leave as it is. */
  const excluded = new SvelteSet<string>();
  let review = $state<PhysicalDeduplicationReviewResponseDto | null>(null);
  let confirmOpen = $state(false);
  let confirmation = $state('');
  let notice = $state('');
  let conflict = $state('');
  let busy = $state(false);
  /** The latest verification of a finished merge (FL-73), and the copy being restored. */
  let verification = $state<PhysicalDeduplicationVerificationDto | null>(null);
  let verifying = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const plan = $derived(preview.plan);
  const effectiveMaster = $derived(keeper ?? null);
  const nameOf = (id: string | null | undefined) => users.find((user) => user.id === id)?.name ?? id ?? '';
  // Looking only in the keeper's own photos finds nothing to merge, so that choice is not offered;
  // a scope that is no longer offered (it became the keeper) still reads as "Only …'s photos".
  const scopeOptions = $derived.by(() => {
    const options = [
      { label: $t('frameleaf_dupes_merge_everyone'), value: DEDUP_SCOPE_ALL },
      ...users
        .filter((user) => user.id !== effectiveMaster)
        .map((user) => ({ label: $t('frameleaf_dupes_merge_only', { values: { name: user.name } }), value: user.id })),
    ];
    return options.some((option) => option.value === scope)
      ? options
      : [...options, { label: $t('frameleaf_dupes_merge_only', { values: { name: nameOf(scope) } }), value: scope }];
  });
  const keeperOptions = $derived(users.map((user) => ({ label: user.name, value: user.id })));
  const configError = $derived(
    dedupConfigurationError({
      enabled: preview.enabled,
      masterUserId: effectiveMaster,
      accountIds: users.map((user) => user.id),
    }),
  );
  const groups = $derived(plan ? groupPlanCopies(plan) : []);
  const selection = $derived(plan ? planSelection(plan, excluded) : null);
  const stale = $derived(plan ? planStaleReason(plan, { scope, masterUserId: effectiveMaster }) : null);
  /** The newest job merging the list on screen. */
  const planApply = $derived(applyForPlan(preview.applies, plan));
  const metrics = $derived(plan ? planMetrics(plan, planApply) : null);
  /** Whichever job is merging right now, this one or another administrator's. */
  const activeApply = $derived(preview.applies.find((apply) => isApplyActive(apply)) ?? null);
  const applied = $derived(planApply?.status === MediaOperationStatus.Completed);
  const merged = $derived(applied || plan?.mode === PhysicalDeduplicationPlanMode.Apply);
  const applyBlocked = $derived(
    plan
      ? applyBlockedReason({
          plan,
          enabled: preview.enabled,
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
   * only lock while Frameleaf is looking or a list is being or has been merged.
   */
  const decisionsLocked = $derived(['running', 'applying', 'applied'].includes(applyBlocked ?? ''));
  const reviewed = $derived(reviewMatches(review, plan, excluded));
  const canConfirm = $derived(
    !!plan && reviewed && !stale && !applyBlocked && !busy && matchesTyped(confirmationPhrase(plan), confirmation),
  );

  /** `{owner} · {bytes}{detail ? " · " + detail : ""}`. */
  const detailSuffix = (item: Parameters<typeof mediaDetail>[0]) => {
    const detail = mediaDetail(item);
    return detail ? ` · ${detail}` : '';
  };

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
          notice = $t('frameleaf_dupes_merge_notice_found');
        }
      }
      if (wasApplying && !next.applying) {
        const finished = applyForPlan(next.applies, next.plan);
        if (finished?.status === MediaOperationStatus.Completed) {
          notice = $t('frameleaf_dupes_merge_notice_merged');
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

  /** A 409 means the list on screen no longer describes the library; show what is true now. */
  const handleConflict = async (error: unknown, fallback: string) => {
    if (isHttpError(error) && error.status === 409) {
      review = null;
      confirmOpen = false;
      conflict = $t('frameleaf_dupes_merge_conflict');
      await refresh();
      if (preview.applying) {
        startPolling();
      }
      return;
    }
    handleError(error, fallback);
  };

  const prepare = async () => {
    if (!effectiveMaster || configError) {
      return;
    }
    busy = true;
    try {
      await requestPhysicalDeduplicationPreview({
        physicalDeduplicationPreviewRequestDto: {
          masterUserId: effectiveMaster,
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

  /** "I have checked this list": the server checks every file on it again before merging is offered. */
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
      notice = $t('frameleaf_dupes_merge_notice_checked');
    } catch (error) {
      await handleConflict(error, $t('frameleaf_dedup_unable_to_review'));
    } finally {
      busy = false;
    }
  };

  const onChecked = async (box: HTMLInputElement) => {
    if (box.checked) {
      await markReviewed();
    } else {
      review = null;
      confirmation = '';
    }
    box.checked = reviewed;
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
          // The phrase itself, whatever capitals it was typed in.
          confirmation: confirmationPhrase(plan),
        },
      });
      confirmOpen = false;
      confirmation = '';
      notice = $t('frameleaf_dupes_merge_notice_merging');
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

  /** Verify a finished merge (FL-73): nothing is written. */
  const verify = async (job: PhysicalDeduplicationApplyDto) => {
    busy = true;
    verifying = job.operationId;
    try {
      verification = await verifyPhysicalDeduplicationApply({ id: job.operationId });
    } catch (error) {
      handleError(error, $t('frameleaf_dedup_unable_to_verify'));
    } finally {
      busy = false;
      verifying = null;
    }
  };

  /** Put one copy back on its own file, where that file is still on disk (FL-73). */
  const restore = async (assetId: string) => {
    if (!verification) {
      return;
    }
    busy = true;
    try {
      verification = await restorePhysicalDeduplicationCopy({
        id: verification.operationId,
        physicalDeduplicationRestoreRequestDto: { assetId },
      });
      notice = $t('frameleaf_dedup_notice_restored');
    } catch (error) {
      handleError(error, $t('frameleaf_dedup_unable_to_restore'));
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
        return $t('frameleaf_dupes_merge_blocked_running');
      }
      case 'applying': {
        return $t('frameleaf_dupes_merge_blocked_applying');
      }
      case 'applied': {
        return $t('frameleaf_dupes_merge_blocked_applied');
      }
      case 'disabled': {
        return $t('frameleaf_dupes_merge_blocked_disabled');
      }
      case 'no-shares': {
        return $t('frameleaf_dupes_merge_blocked_no_shares');
      }
      default: {
        return '';
      }
    }
  });

  const staleMessage = $derived(
    stale === 'scope'
      ? $t('frameleaf_dupes_merge_stale_scope')
      : stale === 'master'
        ? $t('frameleaf_dupes_merge_stale_keeper')
        : '',
  );

  const configErrorMessage = $derived(
    configError === 'disabled'
      ? $t('frameleaf_dupes_merge_disabled')
      : configError === 'no-master'
        ? $t('frameleaf_dupes_merge_no_account')
        : '',
  );

  /** The answer the page opens on. */
  const hero = $derived.by(() => {
    if (preview.running) {
      return {
        tone: 'quiet' as const,
        icon: mdiMagnify,
        title: $t('frameleaf_dupes_merge_hero_looking'),
        body: $t('frameleaf_dupes_merge_hero_looking_body'),
      };
    }
    if (activeApply) {
      return {
        tone: 'quiet' as const,
        icon: mdiProgressClock,
        title: $t('frameleaf_dupes_merge_hero_merging'),
        body: $t('frameleaf_dupes_merge_hero_merging_body'),
      };
    }
    if (!plan || !metrics) {
      return {
        tone: 'quiet' as const,
        icon: mdiMagnify,
        title: $t('frameleaf_dupes_merge_hero_start'),
        body: $t('frameleaf_dupes_merge_hero_start_body'),
      };
    }
    if (merged) {
      return {
        tone: 'good' as const,
        icon: mdiCheckCircleOutline,
        title: $t('frameleaf_dupes_merge_hero_merged'),
        body: $t('frameleaf_dupes_merge_hero_merged_body'),
      };
    }
    if (metrics.copiesToShare > 0) {
      return {
        tone: 'good' as const,
        icon: mdiContentCopy,
        title: $t('frameleaf_dupes_merge_hero_found', { values: { count: metrics.copiesToShare } }),
        body: $t('frameleaf_dupes_merge_hero_found_body', {
          values: { originals: metrics.retainedOriginals, size: formatBytes(metrics.reclaimableBytes) },
        }),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiCheckCircleOutline,
      title: $t('frameleaf_dupes_merge_hero_none'),
      body: $t('frameleaf_dupes_merge_hero_none_body'),
    };
  });
</script>

<KitPage>
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_dupes_merge_status')}
  />

  <Section title={$t('frameleaf_dupes_merge_where')}>
    <Row label={$t('frameleaf_dupes_merge_look_in')}>
      <Select
        label={$t('frameleaf_dupes_merge_look_in')}
        options={scopeOptions}
        value={scope}
        disabled={preview.running}
        onChange={(value) => {
          scope = value;
          confirmation = '';
        }}
      />
    </Row>
    <Row label={$t('frameleaf_dupes_merge_keep_with')} help={$t('frameleaf_dupes_merge_keep_with_help')}>
      <Select
        label={$t('frameleaf_dupes_merge_keep_with')}
        options={keeperOptions}
        value={keeper ?? ''}
        disabled={preview.running}
        onChange={(value) => {
          keeper = value;
          confirmation = '';
        }}
      />
    </Row>
    {#if configErrorMessage}
      <Notice tone="warn" title={configErrorMessage} />
    {/if}
    <div class="actions">
      <Button
        variant={plan ? 'default' : 'primary'}
        disabled={!!configError || preview.running || busy}
        onclick={prepare}
      >
        <Icon icon={mdiMagnify} size="1em" aria-hidden={true} />
        {plan ? $t('frameleaf_dupes_look_again') : $t('frameleaf_dupes_merge_find')}
      </Button>
    </div>
  </Section>

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
    <section class="apply-panel" aria-label={$t('frameleaf_dupes_merge_running_label')}>
      <div class="apply-head">
        <div>
          <Badge value={$t(applyStatusKey(current))} label={$t(applyStatusKey(current))} tone="blue" />
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
        aria-label={$t('frameleaf_dupes_merge_running_label')}
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

  {#if plan && metrics}
    <Section title={$t('frameleaf_dupes_merge_list')} description={$t('frameleaf_dupes_merge_list_body')}>
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
                    {$t('frameleaf_dupes_merge_kept_file')}
                  </span>
                  <strong>{group.retained.originalFileName}</strong>
                  <small>
                    {group.retained.ownerName} · {formatBytes(group.retained.sizeInBytes)}{detailSuffix(group.retained)}
                  </small>
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
                      <span>{$t('frameleaf_dupes_merge_include')}</span>
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
                    <small>{copy.originalFileName} · {formatBytes(copy.sizeInBytes)}{detailSuffix(copy)}</small>
                    <span class="decision" class:share={shares}>
                      <Icon
                        icon={shares ? mdiCheckCircleOutline : mdiMinusCircleOutline}
                        size="0.875rem"
                        aria-hidden={true}
                      />
                      {#if shares}
                        {$t('frameleaf_dupes_merge_copy_back', { values: { size: formatBytes(copy.sizeInBytes) } })}
                      {:else if copy.decision === PhysicalDeduplicationDecision.Share}
                        {$t('frameleaf_dupes_merge_copy_left')}
                      {:else}
                        {$t('frameleaf_dupes_merge_copy_skip', { values: { reason: $t(skipReasonKey(copy.reason)) } })}
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
                              ? $t('frameleaf_dupes_merge_same_file')
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

      <Row label={$t('frameleaf_dupes_merge_space')} help={$t('frameleaf_dupes_merge_space_help')}>
        <strong class="value">{formatBytes(metrics.reclaimableBytes)}</strong>
      </Row>

      <div class="queue-actions">
        <p class="queue-note">
          {#if selection && selection.keptGroups > 0 && !applyBlocked}
            {$t('frameleaf_dupes_merge_selection', {
              values: { copies: selection.copies, kept: selection.keptGroups },
            })}
          {:else}
            {blockedMessage || $t('frameleaf_dupes_merge_requires')}
          {/if}
        </p>
        <div class="queue-buttons">
          {#if merged}
            <span class="done">
              <Icon icon={mdiCheckCircleOutline} size="1em" aria-hidden={true} />
              {$t('frameleaf_dupes_merge_done')}
            </span>
            {#if planApply && canVerifyApply(planApply)}
              {@const job = planApply}
              <Button disabled={busy} onclick={() => verify(job)}>
                <Icon icon={mdiShieldSearch} size="1em" aria-hidden={true} />
                {$t('frameleaf_dedup_verify')}
              </Button>
            {/if}
          {:else}
            <label class="checked">
              <input
                type="checkbox"
                checked={reviewed}
                disabled={!!stale || reviewBlocked || busy}
                onchange={(event) => onChecked(event.currentTarget)}
              />
              <span>{$t('frameleaf_dupes_merge_checked')}</span>
            </label>
            <Button
              variant="primary"
              disabled={!reviewed || !!stale || !!applyBlocked || busy}
              onclick={() => {
                confirmation = '';
                conflict = '';
                confirmOpen = true;
              }}
            >
              {$t('frameleaf_dupes_merge_go')}
            </Button>
          {/if}
        </div>
      </div>

      <Advanced summary={$t('frameleaf_dupes_merge_details')}>
        <p class="note">
          {$t('frameleaf_dupes_merge_plan', { values: { plan: plan.planId, time: time(plan.ranAt) } })}
        </p>
        <Facts
          rows={[
            { label: $t('frameleaf_dedup_metric_copies'), value: String(metrics.copiesToShare) },
            { label: $t('frameleaf_dedup_metric_retained'), value: String(metrics.retainedOriginals) },
            { label: $t('frameleaf_dedup_metric_reclaim'), value: formatBytes(metrics.reclaimableBytes) },
            { label: $t('frameleaf_dedup_metric_skipped'), value: String(metrics.skippedCopies) },
          ]}
        />
        <!-- FL-73: logical asset bytes, physical shared-original bytes and measured reclaimed bytes, apart. -->
        <dl class="bytes" aria-label={$t('frameleaf_dedup_bytes_label')}>
          <div>
            <dt>{$t('frameleaf_dedup_bytes_logical')}</dt>
            <dd>{formatBytes(metrics.logicalBytes)}</dd>
          </div>
          <div>
            <dt>{$t('frameleaf_dedup_bytes_shared')}</dt>
            <dd>{formatBytes(metrics.sharedOriginalBytes)}</dd>
          </div>
          <div>
            <dt>{$t('frameleaf_dedup_bytes_measured')}</dt>
            <dd>
              {metrics.measuredReclaimedBytes === null
                ? $t('frameleaf_dedup_bytes_not_applied')
                : formatBytes(metrics.measuredReclaimedBytes)}
            </dd>
          </div>
        </dl>
        <p class="note">{$t('frameleaf_dedup_bytes_note')}</p>
        <p class="note">{$t('frameleaf_dedup_note')}</p>
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
                      <summary>{$t('frameleaf_dedup_file_location')}</summary>
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
                        <summary>{$t('frameleaf_dedup_retained_location')}</summary>
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
                      <summary>{$t('frameleaf_dedup_checksum_evidence')}</summary>
                      <small
                        >{$t('frameleaf_dedup_checksum_algorithm', {
                          values: { algorithm: $t(checksumAlgorithmKey(copy.checksum)) },
                        })}</small
                      >
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
                      <small>{$t('frameleaf_dedup_across_plan')}</small>
                    {:else}
                      <span class="muted">—</span>
                    {/if}
                  </td>
                  <td>
                    <strong class:share={shares}>
                      {#if shares}
                        {$t('frameleaf_dupes_merge_copy_back', { values: { size: formatBytes(copy.sizeInBytes) } })}
                      {:else if copy.decision === PhysicalDeduplicationDecision.Share}
                        {$t('frameleaf_dupes_merge_copy_left')}
                      {:else}
                        {$t('frameleaf_dupes_merge_copy_skip', { values: { reason: $t(skipReasonKey(copy.reason)) } })}
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
        <div class="actions">
          <Button onclick={exportReview}>
            <Icon icon={mdiDownload} size="1em" aria-hidden={true} />
            {$t('frameleaf_dupes_merge_download')}
          </Button>
        </div>
      </Advanced>
    </Section>
  {/if}

  {#if preview.applies.length > 0}
    <Advanced summary={$t('frameleaf_dupes_merge_history')}>
      <ol class="history">
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
            <span class="history-end">
              <time datetime={entry.finishedAt ?? entry.createdAt}>{time(entry.finishedAt ?? entry.createdAt)}</time>
              {#if canVerifyApply(entry)}
                <Button disabled={busy} onclick={() => verify(entry)}>
                  {verifying === entry.operationId ? $t('frameleaf_dedup_verifying') : $t('frameleaf_dedup_verify')}
                </Button>
              {/if}
            </span>
          </li>
        {/each}
      </ol>
    </Advanced>
  {/if}

  {#if verification}
    {@const report = verification}
    <!-- FL-73 verification: no prototype screen; composed from this page's merge panel and copy list. -->
    <section class="verify-panel" aria-label={$t('frameleaf_dedup_verify_title', { values: { plan: report.planId } })}>
      <div class="apply-head">
        <div>
          <Icon icon={mdiShieldSearch} size="1.125rem" aria-hidden={true} />
          <strong>{$t('frameleaf_dedup_verify_title', { values: { plan: report.planId } })}</strong>
          <small>{time(report.verifiedAt)}</small>
        </div>
        <Button onclick={() => (verification = null)}>{$t('close')}</Button>
      </div>
      <p class="apply-counts" role="status">
        {$t('frameleaf_dedup_verify_counts', {
          values: {
            verified: report.verified,
            copies: report.copies,
            intact: report.retainedIntact,
            originals: report.retainedOriginals,
          },
        })}
      </p>
      {#if report.retainedMissing + report.retainedChanged > 0}
        <p class="message error" role="alert">
          {$t('frameleaf_dedup_verify_retained_problem', {
            values: { missing: report.retainedMissing, changed: report.retainedChanged },
          })}
        </p>
      {/if}
      {#if report.notLinked > 0}
        <p class="message" role="status">
          {$t('frameleaf_dedup_verify_not_linked', { values: { count: report.notLinked } })}
        </p>
      {/if}
      <p class="note">
        {$t('frameleaf_dedup_undo_summary', { values: { removed: report.removed, restorable: report.restorable } })}
      </p>
      {#if report.hiddenCopies > 0}
        <p class="message" role="status">
          <Icon icon={mdiLockOutline} size="1em" aria-hidden={true} />
          {$t('frameleaf_dedup_verify_hidden', { values: { count: report.hiddenCopies } })}
        </p>
      {/if}
      {#if report.items.length > 0}
        <ul class="verify-items" aria-label={$t('frameleaf_dedup_copies_label')}>
          {#each report.items as item (item.assetId)}
            <li>
              <PhysicalDedupThumb assetId={item.assetId} type={item.type} canView={item.canView} size="cell" />
              <div>
                <strong>{item.originalFileName}</strong>
                <small>
                  {$t('frameleaf_dedup_copy_of', { values: { name: item.ownerName } })} · {$t(
                    verificationItemKey(item),
                  )}
                </small>
                <small>{$t(undoKey(item))}</small>
              </div>
              {#if item.restorable}
                <Button disabled={busy} onclick={() => restore(item.assetId)}>{$t('frameleaf_dedup_restore')}</Button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</KitPage>

<Dialog
  title={$t('frameleaf_dupes_merge_confirm_title', { values: { count: review?.copies ?? 0 } })}
  closeLabel={$t('close')}
  bind:open={confirmOpen}
>
  {#if plan && review}
    <div class="confirm">
      <p>
        {$t('frameleaf_dupes_merge_confirm_body', {
          values: { originals: review.retainedOriginals, name: plan.masterUserName },
        })}
      </p>
      <p class="quiet">
        {$t('frameleaf_dupes_merge_confirm_trash', { values: { size: formatBytes(review.estimatedBytes) } })}
      </p>
      {#if review.hiddenCopies > 0}
        <p>{$t('frameleaf_dedup_hidden_copies', { values: { count: review.hiddenCopies } })}</p>
      {/if}
      <p class="quiet">{$t('frameleaf_dedup_confirm_backup')}</p>
      <div class="confirm-typed">
        <TypedConfirmation
          label={$t('frameleaf_dedup_confirm_label', { values: { phrase: confirmationPhrase(plan) } })}
          maxlength={90}
          bind:value={confirmation}
        />
      </div>
      {#if conflict || blockedMessage || staleMessage}
        <p class="message" role="alert">{conflict || blockedMessage || staleMessage}</p>
      {/if}
      <div class="confirm-actions">
        <Button onclick={() => (confirmOpen = false)} disabled={busy}>{$t('cancel')}</Button>
        <Button variant="danger" disabled={!canConfirm} onclick={apply}>
          {$t('frameleaf_dupes_merge_confirm_button', { values: { count: review.copies } })}
        </Button>
      </div>
    </div>
  {/if}
</Dialog>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    justify-content: flex-end;
  }
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
  .message.error {
    border-color: var(--fl-danger);
    color: var(--fl-danger);
  }
  .message :global(svg) {
    vertical-align: -0.125em;
  }
  .empty {
    padding: 2.75rem 1.25rem;
    text-align: center;
    color: var(--fl-muted);
  }
  .value {
    font-weight: 600;
  }
  .groups {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
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
    margin-block: var(--fl-space-3);
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
  .unavailable-text {
    color: var(--fl-danger) !important;
  }
  .group-decision,
  .checked {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    font-size: var(--fl-font-small);
    cursor: pointer;
  }
  .group-decision {
    margin-block-start: 0.25rem;
  }
  .group-decision input,
  .checked input {
    width: 1rem;
    height: 1rem;
    accent-color: var(--fl-accent);
  }
  .queue-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
  }
  .queue-note {
    margin: 0;
    flex: 1 1 16rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .queue-buttons {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
  }
  .done {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--fl-teal);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .bytes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--fl-space-2);
    margin: var(--fl-space-3) 0;
  }
  .bytes div {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.5rem 0.875rem;
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
  }
  .bytes dt {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .bytes dd {
    margin: 0;
    font-weight: 600;
  }
  .apply-panel,
  .verify-panel {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
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
    gap: var(--fl-space-3);
  }
  .apply-head > div:first-child {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .apply-head small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .apply-buttons {
    display: flex;
    gap: var(--fl-space-2);
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
  .history {
    list-style: none;
    margin: 0;
    padding: 0;
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
  .history-end {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    flex-shrink: 0;
  }
  .verify-items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .verify-items li {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding-block: 0.5rem;
    border-block-start: 1px solid var(--fl-border);
  }
  .verify-items li > div {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }
  .verify-items strong {
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
  .verify-items small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .confirm p {
    margin: 0 0 0.75rem;
  }
  .confirm p.quiet {
    color: var(--fl-muted);
  }
  .confirm-typed {
    margin-block: 1rem;
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--fl-space-2);
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
    .copies {
      grid-template-columns: 1fr;
    }
  }
</style>
