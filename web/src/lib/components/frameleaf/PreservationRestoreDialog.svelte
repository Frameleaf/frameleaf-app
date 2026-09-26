<script lang="ts">
  /**
   * Restore from a preservation package (FL-74, `IMP-006`).
   *
   * The design's workflow dialog pattern — stepper, facts, one primary action — for the restoration
   * the prototype's preservation screens lead to: Package → Check → Review → Restore.
   *
   * - **Package.** A package this server wrote, one uploaded from this browser, or — for an
   *   administrator — one named on the server, and what to do where it disagrees with the library.
   * - **Check.** A durable review job verifies every file against the manifest and compares each
   *   original with the library: new, already held, or in the trash. Nothing is written.
   * - **Review.** The fields that disagree, item by item, with the owner's choice of keeping the
   *   library's value or taking the package's; what fails verification; and, category by category,
   *   what a restoration brings back, keeps as provenance or leaves out.
   * - **Restore.** A durable restore job adds what the library lacks and matches what it has. An
   *   existing original is never replaced and never duplicated; a retry keeps every choice and
   *   never touches an item it already restored.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PreservationJobStatus from '$lib/components/frameleaf/PreservationJobStatus.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import {
    RESTORE_STEPS,
    conflictFieldKey,
    findingKey,
    groupSupport,
    isOperationActive,
    newRequestKey,
    pollDelay,
    reasonKey,
    restoreState,
    restoreStep,
    supportCategoryKey,
    supportLevelKey,
    supportTone,
  } from '$lib/frameleaf/preservation';
  import { downloadBlob } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    applyPreservationRestore,
    createPreservationRestore,
    getPreservationRestore,
    getPreservationRestoreItems,
    PreservationDecision,
    PreservationRestoreItemFilter,
    PreservationRestoreStatus,
    registerPreservationServerPackage,
    updatePreservationRestoreDecisions,
    uploadPreservationPackage,
    type PreservationConflictField,
    type PreservationPackageDto,
    type PreservationRestoreDto,
    type PreservationRestoreItemDto,
  } from '@immich/sdk';
  import { onDestroy, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    open?: boolean;
    /** A restoration to reopen where it was left; null starts a new one. */
    restore?: PreservationRestoreDto | null;
    /** Packages that can be restored from. */
    packages: PreservationPackageDto[];
    /** The chosen package when started from a package row. */
    packageId?: string | null;
    isAdmin?: boolean;
    onChanged?: () => void;
  };

  let {
    open = $bindable(false),
    restore = $bindable(null),
    packages,
    packageId = null,
    isAdmin = false,
    onChanged,
  }: Props = $props();

  type Source = 'package' | 'upload' | 'server';
  const PAGE = 50;

  let source = $state<Source>('package');
  let chosenPackage = $state<string | null>(null);
  let file = $state<File | null>(null);
  let serverPath = $state('');
  let restoreEditRecipes = $state(true);
  let conflictDefault = $state<PreservationDecision>(PreservationDecision.Keep);
  let busy = $state(false);
  let filter = $state<PreservationRestoreItemFilter>(PreservationRestoreItemFilter.Conflicts);
  let skip = $state(0);
  let items = $state<PreservationRestoreItemDto[]>([]);
  let total = $state(0);
  let requestKey = $state(newRequestKey());
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const step = $derived(restoreStep(restore));
  const restorable = $derived(packages.filter((item) => item.restorable));
  const canCheck = $derived(
    !busy &&
      ((source === 'package' && !!chosenPackage) ||
        (source === 'upload' && !!file) ||
        (source === 'server' && isAdmin && serverPath.trim().length > 0)),
  );
  const running = $derived(isOperationActive(restore?.operation));
  const badge = $derived(restore ? restoreState(restore) : null);
  const organization = $derived(
    restore
      ? $t('frameleaf_preservation_restore_organization_value', {
          values: { albums: restore.albums, people: restore.people },
        })
      : '',
  );

  const sourceOptions = $derived([
    { value: 'package', label: $t('frameleaf_preservation_restore_source_package') },
    { value: 'upload', label: $t('frameleaf_preservation_restore_source_upload') },
    ...(isAdmin ? [{ value: 'server', label: $t('frameleaf_preservation_restore_source_server') }] : []),
  ]);
  const decisionOptions = $derived([
    { value: PreservationDecision.Keep, label: $t('frameleaf_preservation_decision_keep') },
    { value: PreservationDecision.Replace, label: $t('frameleaf_preservation_decision_replace') },
  ]);
  const filterOptions = $derived([
    { value: PreservationRestoreItemFilter.Conflicts, label: $t('frameleaf_preservation_review_conflicts') },
    { value: PreservationRestoreItemFilter.Failed, label: $t('frameleaf_preservation_review_failed') },
    { value: PreservationRestoreItemFilter.Findings, label: $t('frameleaf_preservation_review_findings') },
  ]);

  /* ---------------------------------------------------------------- */

  const refresh = async () => {
    if (!restore) {
      return;
    }
    try {
      const next = await getPreservationRestore({ id: restore.id });
      const changedStep = restoreStep(next) !== restoreStep(restore);
      restore = next;
      if (changedStep) {
        skip = 0;
        filter =
          next.status === PreservationRestoreStatus.Ready
            ? PreservationRestoreItemFilter.Conflicts
            : PreservationRestoreItemFilter.Findings;
        await loadItems();
        onChanged?.();
      }
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_restore_error'));
    }
    schedule();
  };

  const schedule = () => {
    clearTimeout(pollTimer);
    const delay = open ? pollDelay([restore?.operation]) : null;
    if (delay) {
      pollTimer = setTimeout(() => void refresh(), delay);
    }
  };

  const loadItems = async () => {
    if (!restore || step < 2) {
      items = [];
      total = 0;
      return;
    }
    try {
      const page = await getPreservationRestoreItems({ id: restore.id, filter, skip, take: PAGE });
      items = page.items;
      total = page.total;
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_restore_error'));
    }
  };

  const check = async () => {
    busy = true;
    try {
      let target = chosenPackage;
      if (source === 'upload' && file) {
        target = (await uploadPreservationPackage({ preservationUploadCreateDto: { file } })).id;
      } else if (source === 'server') {
        target = (
          await registerPreservationServerPackage({
            preservationServerPackageCreateDto: { path: serverPath.trim() },
          })
        ).id;
      }
      if (!target) {
        return;
      }
      restore = await createPreservationRestore({
        preservationRestoreCreateDto: { packageId: target, restoreEditRecipes, conflictDefault, requestKey },
      });
      onChanged?.();
      schedule();
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_restore_check_error'));
    } finally {
      busy = false;
    }
  };

  const setDecision = async (item: PreservationRestoreItemDto, field: PreservationConflictField, decision: string) => {
    if (!restore) {
      return;
    }
    const decisions: Record<string, PreservationDecision> = {};
    for (const conflict of item.conflicts) {
      if (conflict.decision) {
        decisions[conflict.field] = conflict.decision;
      }
    }
    decisions[field] = decision as PreservationDecision;
    try {
      restore = await updatePreservationRestoreDecisions({
        id: restore.id,
        preservationDecisionsUpdateDto: { items: [{ id: item.id, decisions }] },
      });
      items = items.map((row) =>
        row.id === item.id
          ? {
              ...row,
              conflicts: row.conflicts.map((conflict) =>
                conflict.field === field ? { ...conflict, decision: decision as PreservationDecision } : conflict,
              ),
            }
          : row,
      );
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_restore_decision_error'));
    }
  };

  const setDefault = async (value: string) => {
    if (!restore) {
      conflictDefault = value as PreservationDecision;
      return;
    }
    try {
      restore = await updatePreservationRestoreDecisions({
        id: restore.id,
        preservationDecisionsUpdateDto: { conflictDefault: value as PreservationDecision },
      });
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_restore_decision_error'));
    }
  };

  const apply = async () => {
    if (!restore) {
      return;
    }
    busy = true;
    try {
      const operation = await applyPreservationRestore({ id: restore.id });
      restore = { ...restore, status: PreservationRestoreStatus.Restoring, operation };
      onChanged?.();
      schedule();
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_restore_apply_error'));
    } finally {
      busy = false;
    }
  };

  /** Every item of the restoration and what happened to it, for the owner's records. */
  const downloadReport = async () => {
    if (!restore) {
      return;
    }
    busy = true;
    try {
      const all: PreservationRestoreItemDto[] = [];
      for (let offset = 0; ; offset += 200) {
        const page = await getPreservationRestoreItems({ id: restore.id, skip: offset, take: 200 });
        all.push(...page.items);
        if (page.items.length < 200 || all.length >= page.total) {
          break;
        }
      }
      const report = JSON.stringify({ restoration: restore, items: all }, null, 2);
      downloadBlob(new Blob([report], { type: 'application/json' }), `restoration-report-${restore.id}.json`);
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_restore_error'));
    } finally {
      busy = false;
    }
  };

  const back = () => {
    open = false;
  };

  // Opening starts from the given restoration or a fresh choice, and follows its job while open.
  $effect(() => {
    if (open) {
      untrack(() => {
        requestKey = newRequestKey();
        chosenPackage = packageId ?? restorable[0]?.id ?? null;
        source = 'package';
        skip = 0;
        filter =
          restore?.status === PreservationRestoreStatus.Ready
            ? PreservationRestoreItemFilter.Conflicts
            : PreservationRestoreItemFilter.Findings;
        void loadItems();
        schedule();
      });
    } else {
      clearTimeout(pollTimer);
    }
  });

  onDestroy(() => clearTimeout(pollTimer));
</script>

<Dialog bind:open title={$t('frameleaf_preservation_restore_title')} closeLabel={$t('close')} wide>
  <div class="workflow">
    <ol class="stepper">
      {#each RESTORE_STEPS as key, index (key)}
        <li aria-current={step === index ? 'step' : undefined}>
          <span>{index + 1}</span>{$t(key)}
        </li>
      {/each}
    </ol>

    {#if step === 0}
      <p>{$t('frameleaf_preservation_restore_intro')}</p>
      <SegmentedControl
        label={$t('frameleaf_preservation_restore_source')}
        options={sourceOptions}
        value={source}
        onChange={(value) => (source = value as Source)}
      />
      {#if source === 'package'}
        {#if restorable.length === 0}
          <p class="hint">{$t('frameleaf_preservation_restore_no_packages')}</p>
        {:else}
          <ul class="choices" aria-label={$t('frameleaf_preservation_restore_source_package')}>
            {#each restorable as item (item.id)}
              <li>
                <label>
                  <input type="radio" name="preservation-package" value={item.id} bind:group={chosenPackage} />
                  <span>{item.name}</span>
                  <small>{$t(`frameleaf_preservation_origin_${item.origin}`)}</small>
                </label>
              </li>
            {/each}
          </ul>
        {/if}
      {:else if source === 'upload'}
        <label class="field">
          {$t('frameleaf_preservation_restore_upload_label')}
          <input
            type="file"
            accept=".zip,application/zip"
            onchange={(event) => (file = (event.currentTarget as HTMLInputElement).files?.[0] ?? null)}
          />
          <small>{$t('frameleaf_preservation_restore_upload_help')}</small>
        </label>
      {:else}
        <label class="field">
          {$t('frameleaf_preservation_restore_server_label')}
          <input type="text" bind:value={serverPath} placeholder="/backups/frameleaf-preservation" />
          <small>{$t('frameleaf_preservation_restore_server_help')}</small>
        </label>
      {/if}
      <div class="controls">
        <SettingToggle
          title={$t('frameleaf_preservation_restore_edits')}
          subtitle={$t('frameleaf_preservation_restore_edits_help')}
          bind:checked={restoreEditRecipes}
        />
        <div class="row">
          <div>
            <strong>{$t('frameleaf_preservation_restore_default')}</strong>
            <p>{$t('frameleaf_preservation_restore_default_help')}</p>
          </div>
          <SegmentedControl
            label={$t('frameleaf_preservation_restore_default')}
            options={decisionOptions}
            value={conflictDefault}
            onChange={(value) => (conflictDefault = value as PreservationDecision)}
          />
        </div>
      </div>
    {:else if restore}
      <div class="head">
        <p>
          <strong>{restore.name}</strong>
          {#if badge}
            <Badge tone={badge.tone} value={$t(badge.key)} label={$t(badge.key)} />
          {/if}
        </p>
        {#if restore.operation}
          <PreservationJobStatus operation={restore.operation} onChanged={() => void refresh()} />
        {/if}
      </div>

      {#if restore.status === PreservationRestoreStatus.Unreadable}
        <p class="note" role="alert">
          {$t(reasonKey(restore.reasonKey) ?? 'frameleaf_preservation_reason_other')}
        </p>
      {:else if step >= 2}
        <dl class="facts">
          <dt>{$t('frameleaf_preservation_restore_new')}</dt>
          <dd>{restore.counts.new}</dd>
          <dt>{$t('frameleaf_preservation_restore_existing')}</dt>
          <dd>{restore.counts.existing}</dd>
          <dt>{$t('frameleaf_preservation_restore_trashed')}</dt>
          <dd>{restore.counts.trashed}</dd>
          <dt>{$t('frameleaf_preservation_restore_failed')}</dt>
          <dd>{restore.counts.failed}</dd>
          <dt>{$t('frameleaf_preservation_restore_conflicts')}</dt>
          <dd>{restore.counts.conflicts}</dd>
          <dt>{$t('frameleaf_preservation_restore_organization')}</dt>
          <dd>{organization}</dd>
          {#if step === 3}
            <dt>{$t('frameleaf_preservation_restore_restored')}</dt>
            <dd>{restore.counts.restored}</dd>
            <dt>{$t('frameleaf_preservation_restore_matched')}</dt>
            <dd>{restore.counts.matched}</dd>
          {/if}
        </dl>
        {#if restore.counts.trashed > 0}
          <p class="note">{$t('frameleaf_preservation_restore_trashed_help')}</p>
        {/if}

        <div class="row">
          <div>
            <strong>{$t('frameleaf_preservation_restore_default')}</strong>
            <p>{$t('frameleaf_preservation_restore_default_help')}</p>
          </div>
          <SegmentedControl
            label={$t('frameleaf_preservation_restore_default')}
            options={decisionOptions}
            value={restore.conflictDefault}
            disabled={running}
            onChange={(value) => void setDefault(value)}
          />
        </div>

        <SegmentedControl
          label={$t('frameleaf_preservation_review_show')}
          options={filterOptions}
          value={filter}
          onChange={(value) => {
            filter = value as PreservationRestoreItemFilter;
            skip = 0;
            void loadItems();
          }}
        />
        <ul class="items" aria-live="polite">
          {#each items as item (item.id)}
            {@const reason = reasonKey(item.reasonKey)}
            <li>
              <p class="item-name">
                {item.name ?? item.sourceAssetId}
                <small>{$t(`frameleaf_preservation_restore_item_${item.state}`)}</small>
              </p>
              {#if reason}
                <p class="reason">{$t(reason)}</p>
              {/if}
              {#each item.conflicts as conflict (conflict.field)}
                <div class="conflict">
                  <span class="field">{$t(conflictFieldKey(conflict.field))}</span>
                  <span class="value">
                    <small>{$t('frameleaf_preservation_review_library')}</small>
                    {conflict.current ?? '—'}
                  </span>
                  <span class="value">
                    <small>{$t('frameleaf_preservation_review_package')}</small>
                    {conflict.archived ?? '—'}
                  </span>
                  <SegmentedControl
                    label={$t(conflictFieldKey(conflict.field))}
                    options={decisionOptions}
                    value={conflict.decision ?? restore.conflictDefault}
                    disabled={running || item.applied}
                    onChange={(value) => void setDecision(item, conflict.field, value)}
                  />
                </div>
              {/each}
              {#if item.findings.length > 0}
                <ul class="findings">
                  {#each item.findings as finding (finding)}
                    <li>{$t(findingKey(finding))}</li>
                  {/each}
                </ul>
              {/if}
            </li>
          {:else}
            <li class="hint">{$t('frameleaf_preservation_review_empty')}</li>
          {/each}
        </ul>
        {#if total > PAGE}
          <div class="pager">
            <Button
              disabled={skip === 0}
              onclick={() => {
                skip = Math.max(0, skip - PAGE);
                void loadItems();
              }}>{$t('previous')}</Button
            >
            <Button
              disabled={skip + items.length >= total}
              onclick={() => {
                skip += PAGE;
                void loadItems();
              }}>{$t('next')}</Button
            >
          </div>
        {/if}

        <section class="support" aria-labelledby="preservation-restore-support">
          <h3 id="preservation-restore-support">{$t('frameleaf_preservation_support_heading')}</h3>
          {#each groupSupport(restore.support) as group (group.level)}
            <div class="support-group">
              <Badge
                tone={supportTone(group.level)}
                value={group.categories.length}
                label={$t('frameleaf_preservation_support_count', { values: { count: group.categories.length } })}
              />
              <strong>{$t(supportLevelKey(group.level))}</strong>
              <span>{group.categories.map((category) => $t(supportCategoryKey(category))).join(', ')}</span>
            </div>
          {/each}
        </section>
        {#if step === 3 && !running}
          <p class="notice">{$t('frameleaf_preservation_restore_final')}</p>
        {/if}
      {:else}
        <p>{$t('frameleaf_preservation_restore_checking')}</p>
      {/if}
    {/if}

    <footer>
      <Button onclick={back}>{step === 0 ? $t('cancel') : $t('close')}</Button>
      {#if step === 0}
        <Button variant="primary" disabled={!canCheck} onclick={check}>
          {busy ? $t('frameleaf_preservation_checking') : $t('frameleaf_preservation_restore_check')}
        </Button>
      {:else if step === 2}
        <Button variant="primary" disabled={busy || running || !restore} onclick={apply}>
          {$t('frameleaf_preservation_restore_apply')}
        </Button>
      {:else if step === 3 && restore}
        <Button disabled={busy} onclick={downloadReport}>{$t('frameleaf_preservation_restore_report')}</Button>
        {#if !running && restore.counts.failed > 0}
          <Button variant="primary" disabled={busy} onclick={apply}>
            {$t('frameleaf_preservation_restore_again')}
          </Button>
        {/if}
      {/if}
    </footer>
  </div>
</Dialog>

<style>
  .workflow {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    margin-top: 1rem;
    font-size: var(--fl-font-size);
  }
  .workflow p {
    margin: 0;
  }
  .stepper {
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    margin: 0 0 0.5rem;
    padding: 0;
    list-style: none;
  }
  .stepper li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .stepper li > span {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    font-size: var(--fl-font-micro);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: 50%;
  }
  .stepper li[aria-current] {
    color: var(--fl-text);
  }
  .stepper li[aria-current] > span {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .choices,
  .items {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 22rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
  .choices label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .choices input {
    accent-color: var(--fl-accent);
  }
  .choices small,
  .field small,
  .hint,
  .row p,
  .item-name small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: var(--fl-font-small);
  }
  .field input[type='text'] {
    padding: 0.375rem 0.5rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .head p {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .facts {
    display: grid;
    grid-template-columns: minmax(7rem, 12rem) 1fr;
    gap: 0.5rem 1rem;
    margin: 0;
    font-size: var(--fl-font-small);
  }
  .facts dt {
    color: var(--fl-muted);
  }
  .facts dd {
    margin: 0;
  }
  .items > li {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.625rem 0.75rem;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .item-name {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    overflow-wrap: anywhere;
  }
  .conflict {
    display: grid;
    grid-template-columns: minmax(6rem, 8rem) 1fr 1fr auto;
    gap: 0.5rem;
    align-items: center;
    font-size: var(--fl-font-small);
  }
  .conflict .value {
    display: flex;
    flex-direction: column;
    overflow-wrap: anywhere;
  }
  .conflict small {
    color: var(--fl-muted);
  }
  .reason {
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
  .findings {
    margin: 0;
    padding-inline-start: 1.25rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .pager {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .support {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .support h3 {
    margin: 0;
    font-size: var(--fl-font-size);
  }
  .support-group {
    display: grid;
    grid-template-columns: auto minmax(8rem, 12rem) 1fr;
    gap: 0.5rem;
    align-items: baseline;
    font-size: var(--fl-font-small);
  }
  .support-group span {
    color: var(--fl-muted);
  }
  .note,
  .notice {
    padding: 0.625rem 0.875rem;
    font-size: var(--fl-font-small);
    line-height: 1.6;
    background: var(--fl-raised);
    border-left: 2px solid var(--fl-accent);
  }
  .note {
    border-left-color: var(--fl-warning);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  @media (max-width: 40rem) {
    .conflict,
    .facts,
    .support-group {
      grid-template-columns: 1fr;
    }
  }
</style>
