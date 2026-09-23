<script lang="ts">
  /**
   * Physical deduplication preview and apply (FL-71), ported from the design template's
   * `PhysicalDedupManager.jsx`. The template kept a sample plan in localStorage; this page reads
   * the server's dry-run result (`getPhysicalDeduplicationPreview`), prepares a new one through
   * `requestPhysicalDeduplicationPreview` and applies through the existing manual job.
   *
   * Rules carried over from the server contract:
   * - A preview may retain originals in an account chosen here when none is saved.
   * - Applying always uses the saved `physicalDeduplication.masterUserId`; the server refuses
   *   otherwise, and the page mirrors that refusal before offering the action.
   * - Thumbnails are the requester's own asset access (`canView`), never widened by admin rights.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import PhysicalDedupThumb from '$lib/components/frameleaf/PhysicalDedupThumb.svelte';
  import Picker from '$lib/components/frameleaf/Picker.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import {
    applyBlockedReason,
    confirmationPhrase,
    DEDUP_SCOPE_ALL,
    formatBytes,
    groupPlanCopies,
    matchesConfirmation,
    planLabel,
    planMetrics,
    planStaleReason,
    reviewExport,
    skipReasonKey,
  } from '$lib/frameleaf/physical-dedup';
  import { OpenQueryParam } from '$lib/constants';
  import { Route } from '$lib/route';
  import { handleCreateJob } from '$lib/services/job.service';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getPhysicalDeduplicationPreview,
    ManualJobName,
    PhysicalDeduplicationDecision,
    PhysicalDeduplicationPlanMode,
    requestPhysicalDeduplicationPreview,
    type PhysicalDeduplicationPreviewResponseDto,
    type UserAdminResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiCheckCircleOutline,
    mdiCompare,
    mdiDownload,
    mdiFolderSearchOutline,
    mdiHelpCircleOutline,
    mdiLinkVariant,
    mdiLinkVariantOff,
    mdiMinusCircleOutline,
    mdiShieldCheckOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy } from 'svelte';
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
  let reviewedPlan = $state<string | null>(null);
  let confirmOpen = $state(false);
  let confirmation = $state('');
  let notice = $state('');
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
  const masterOptions = $derived(users.map((user) => ({ label: `${user.name} (${user.email})`, value: user.id })));
  const groups = $derived(plan ? groupPlanCopies(plan) : []);
  const metrics = $derived(plan ? planMetrics(plan) : null);
  const stale = $derived(plan ? planStaleReason(plan, { scope, masterUserId: effectiveMaster }) : null);
  const applyBlocked = $derived(
    plan
      ? applyBlockedReason({
          plan,
          enabled: preview.enabled,
          savedMasterUserId: preview.savedMasterUserId,
          running: preview.running,
        })
      : null,
  );
  const label = $derived(plan ? planLabel(plan) : '');
  const reviewed = $derived(!!plan && reviewedPlan === plan.ranAt);
  const canConfirm = $derived(!!plan && reviewed && !stale && !applyBlocked && matchesConfirmation(plan, confirmation));

  const time = (value: string) => DateTime.fromISO(value).toLocaleString(DateTime.DATETIME_MED);

  const refresh = async () => {
    try {
      const next = await getPhysicalDeduplicationPreview();
      const arrived = next.plan?.ranAt !== preview.plan?.ranAt;
      preview = next;
      if (arrived && next.plan) {
        notice =
          next.plan.mode === PhysicalDeduplicationPlanMode.Apply
            ? $t('frameleaf_dedup_notice_applied')
            : $t('frameleaf_dedup_notice_preview_ready');
        view = 'media';
      }
      if (!next.running) {
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
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  onDestroy(stopPolling);

  if (initial.running) {
    startPolling();
  }

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
      reviewedPlan = null;
      confirmation = '';
      notice = '';
      preview = { ...preview, running: true };
      startPolling();
    } catch (error) {
      handleError(error, $t('frameleaf_dedup_unable_to_prepare'));
    } finally {
      busy = false;
    }
  };

  const markReviewed = () => {
    if (!plan) {
      return;
    }
    reviewedPlan = plan.ranAt;
    notice = $t('frameleaf_dedup_notice_reviewed', { values: { plan: label } });
  };

  const apply = async () => {
    if (!canConfirm) {
      return;
    }
    busy = true;
    try {
      const queued = await handleCreateJob({ name: ManualJobName.PhysicalDeduplicationApply });
      if (queued) {
        confirmOpen = false;
        confirmation = '';
        preview = { ...preview, running: true };
        startPolling();
      }
    } finally {
      busy = false;
    }
  };

  const exportReview = () => {
    if (!plan) {
      return;
    }
    const url = URL.createObjectURL(new Blob([reviewExport(plan)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `frameleaf-deduplication-${label}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const blockedMessage = $derived.by(() => {
    switch (applyBlocked) {
      case 'running': {
        return $t('frameleaf_dedup_apply_blocked_running');
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

  const settingsHref = Route.systemSettings({ isOpen: OpenQueryParam.STORAGE_TEMPLATE });
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
        <a href={settingsHref}>{$t('frameleaf_dedup_retained_change')}</a>
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
      <Button variant="primary" disabled={!effectiveMaster || preview.running || busy} onclick={prepare}>
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
      {$t('frameleaf_dedup_preview_uses_chosen')}
      <a href={settingsHref}>{$t('frameleaf_dedup_apply_blocked_no_saved_master')}</a>
    {/if}
  </p>

  {#if preview.running}
    <Status message={$t('frameleaf_dedup_plan_running')} busy />
  {:else if notice}
    <Status message={notice} />
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
        <Badge
          value={plan.mode === PhysicalDeduplicationPlanMode.Apply
            ? $t('frameleaf_dedup_plan_applied')
            : reviewed
              ? $t('frameleaf_dedup_plan_reviewed')
              : $t('frameleaf_dedup_plan_preview')}
          label={plan.mode === PhysicalDeduplicationPlanMode.Apply
            ? $t('frameleaf_dedup_plan_applied')
            : reviewed
              ? $t('frameleaf_dedup_plan_reviewed')
              : $t('frameleaf_dedup_plan_preview')}
          tone={plan.mode === PhysicalDeduplicationPlanMode.Apply ? 'teal' : 'blue'}
        />
        <h2>{label}</h2>
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
        {$t('frameleaf_dedup_truncated', { values: { count: plan.copies.length } })}
      </p>
    {/if}

    {#if view === 'media'}
      <div class="groups">
        {#each groups as group (group.key)}
          {@const first = group.copies[0]}
          <article
            class="group"
            class:skipped={group.shares === 0}
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
                    {#if group.shares > 0}
                      · {$t('frameleaf_dedup_references_after', {
                        values: { before: group.retained.referencesBefore, after: group.retained.referencesAfter },
                      })}
                    {/if}
                  </small>
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
              <Icon icon={group.shares > 0 ? mdiLinkVariant : mdiLinkVariantOff} size="1.125rem" />
            </div>
            <ul class="copies" aria-label={$t('frameleaf_dedup_copies_label')}>
              {#each group.copies as copy (copy.assetId)}
                <li class="copy" class:skipped={copy.decision !== PhysicalDeduplicationDecision.Share}>
                  <PhysicalDedupThumb assetId={copy.assetId} type={copy.type} canView={copy.canView} />
                  <div class="copy-text">
                    <strong>{$t('frameleaf_dedup_copy_of', { values: { name: copy.ownerName } })}</strong>
                    <small>{copy.originalFileName} · {formatBytes(copy.sizeInBytes)}</small>
                    <span class="decision" class:share={copy.decision === PhysicalDeduplicationDecision.Share}>
                      <Icon
                        icon={copy.decision === PhysicalDeduplicationDecision.Share
                          ? mdiCheckCircleOutline
                          : mdiMinusCircleOutline}
                        size="0.875rem"
                        aria-hidden={true}
                      />
                      {copy.decision === PhysicalDeduplicationDecision.Share
                        ? $t('frameleaf_dedup_decision_share', { values: { size: formatBytes(copy.sizeInBytes) } })
                        : $t('frameleaf_dedup_decision_skip', { values: { reason: $t(skipReasonKey(copy.reason)) } })}
                    </span>
                    <details class="evidence">
                      <summary>{$t('frameleaf_dedup_evidence')}</summary>
                      <dl>
                        <div>
                          <dt>{$t('frameleaf_dedup_evidence_file')}</dt>
                          <dd><code>{copy.originalPath}</code></dd>
                        </div>
                        <div>
                          <dt>{$t('frameleaf_dedup_evidence_sha1')}</dt>
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
                    <small>{$t('frameleaf_dedup_table_file_available')}</small>
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
                    <summary>{$t('frameleaf_dedup_evidence_sha1')}</summary>
                    <code>{copy.checksum}</code>
                    {#if retained}
                      <small>{$t('frameleaf_dedup_evidence_retained')}</small>
                      <code>{retained.checksum}</code>
                    {/if}
                  </details>
                </td>
                <td>
                  {#if retained}
                    <strong>{retained.referencesBefore} → {retained.referencesAfter}</strong>
                  {:else}
                    <span class="muted">—</span>
                  {/if}
                </td>
                <td>
                  <strong class:share={copy.decision === PhysicalDeduplicationDecision.Share}>
                    {copy.decision === PhysicalDeduplicationDecision.Share
                      ? $t('frameleaf_dedup_decision_share', { values: { size: formatBytes(copy.sizeInBytes) } })
                      : $t('frameleaf_dedup_decision_skip', { values: { reason: $t(skipReasonKey(copy.reason)) } })}
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
        <span>{blockedMessage || $t('frameleaf_dedup_apply_requires')}</span>
      </div>
      <div class="queue-buttons">
        {#if plan.mode === PhysicalDeduplicationPlanMode.DryRun && !reviewed}
          <Button disabled={!!stale || !!applyBlocked} onclick={markReviewed}>
            {$t('frameleaf_dedup_mark_reviewed')}
          </Button>
        {:else if plan.mode === PhysicalDeduplicationPlanMode.DryRun}
          <Button
            variant="primary"
            disabled={!!stale || !!applyBlocked}
            onclick={() => {
              confirmation = '';
              confirmOpen = true;
            }}
          >
            {$t('frameleaf_dedup_apply')}
          </Button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<Dialog title={$t('frameleaf_dedup_confirm_title')} closeLabel={$t('close')} bind:open={confirmOpen}>
  {#if plan}
    <div class="confirm">
      <p>{$t('frameleaf_dedup_confirm_body')}</p>
      <dl>
        <div><dt>{$t('frameleaf_dedup_plan_preview')}</dt><dd>{label}</dd></div>
        <div>
          <dt>{$t('frameleaf_dedup_scan_scope')}</dt>
          <dd>
            {plan.scopeUserId ? (plan.scopeUserName ?? nameOf(plan.scopeUserId)) : $t('frameleaf_dedup_scope_all')}
          </dd>
        </div>
        <div><dt>{$t('frameleaf_dedup_retain_in')}</dt><dd>{plan.masterUserName}</dd></div>
        <div><dt>{$t('frameleaf_dedup_metric_copies')}</dt><dd>{plan.eligibleAssets}</dd></div>
        <div><dt>{$t('frameleaf_dedup_metric_reclaim')}</dt><dd>{formatBytes(plan.reclaimableBytes)}</dd></div>
      </dl>
      <p>{$t('frameleaf_dedup_confirm_backup')}</p>
      <label>
        <span>{$t('frameleaf_dedup_confirm_label', { values: { phrase: confirmationPhrase(plan) } })}</span>
        <input type="text" autocomplete="off" spellcheck="false" maxlength="90" bind:value={confirmation} />
      </label>
      {#if blockedMessage || staleMessage}
        <p class="message" role="alert">{blockedMessage || staleMessage}</p>
      {/if}
      <div class="confirm-actions">
        <Button onclick={() => (confirmOpen = false)} disabled={busy}>{$t('cancel')}</Button>
        <Button variant="primary" disabled={!canConfirm || busy} onclick={apply}>{$t('frameleaf_dedup_apply')}</Button>
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
  .retained-saved a,
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
