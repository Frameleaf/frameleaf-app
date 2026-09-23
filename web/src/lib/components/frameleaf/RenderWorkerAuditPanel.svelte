<script lang="ts">
  /**
   * The render worker audit trail (FL-95): enrolments, admissions, refusals, limit stops and
   * revocations, newest first, with the stable refusal code turned into a sentence. The server
   * never writes a secret or a file path into an audit row, so `detail` is shown in full.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import {
    auditDetailEntries,
    auditEventIsRefusal,
    auditEventKey,
    refusalReasonKey,
  } from '$lib/frameleaf/render-workers';
  import { locale } from '$lib/stores/preferences.store';
  import type { RenderWorkerAuditDto, RenderWorkerDto, UserAdminResponseDto } from '@immich/sdk';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  let {
    entries,
    workers,
    users,
    refreshing,
    onFilter,
  }: {
    entries: RenderWorkerAuditDto[];
    workers: RenderWorkerDto[];
    users: UserAdminResponseDto[];
    refreshing: boolean;
    /** Re-query the trail, for one worker or for all. */
    onFilter: (workerId: string | undefined) => void;
  } = $props();

  let workerId = $state('');
  const filterId = $props.id();

  const workerName = $derived(new Map(workers.map((worker) => [worker.id, worker.name])));
  const nameOfUser = $derived(new Map(users.map((user) => [user.id, user.name])));

  const at = (value: string) => DateTime.fromISO(value, { locale: $locale }).toLocaleString(DateTime.DATETIME_MED);
</script>

<Pane label={$t('frameleaf_render_workers_audit_title')}>
  <div class="head">
    <div>
      <h2>{$t('frameleaf_render_workers_audit_title')}</h2>
      <p>{$t('frameleaf_render_workers_audit_subtitle')}</p>
    </div>
    <div class="controls">
      <label class="field" for={filterId}>
        <span>{$t('frameleaf_render_workers_audit_filter_label')}</span>
        <select id={filterId} bind:value={workerId} onchange={() => onFilter(workerId === '' ? undefined : workerId)}>
          <option value="">{$t('frameleaf_render_workers_audit_all_workers')}</option>
          {#each workers as worker (worker.id)}
            <option value={worker.id}>{worker.name}</option>
          {/each}
        </select>
      </label>
      <Button disabled={refreshing} onclick={() => onFilter(workerId === '' ? undefined : workerId)}>
        {$t('frameleaf_render_workers_audit_refresh')}
      </Button>
    </div>
  </div>

  {#if entries.length === 0}
    <p class="empty">{$t('frameleaf_render_workers_audit_empty')}</p>
  {:else}
    <ol aria-label={$t('frameleaf_render_workers_audit_list_label')}>
      {#each entries as entry (entry.id)}
        {@const refusal = auditEventIsRefusal(entry.event)}
        <li>
          <div class="line">
            <Badge
              value={$t(auditEventKey[entry.event])}
              label={$t(auditEventKey[entry.event])}
              tone={refusal ? 'warning' : 'neutral'}
            />
            <strong>
              {entry.workerId
                ? (workerName.get(entry.workerId) ?? $t('frameleaf_render_workers_audit_unknown_worker'))
                : $t('frameleaf_render_workers_audit_instance')}
            </strong>
            <time datetime={entry.createdAt}>{at(entry.createdAt)}</time>
            {#if entry.actorId}
              <span class="muted">
                {$t('frameleaf_render_workers_audit_by', {
                  values: { name: nameOfUser.get(entry.actorId) ?? $t('frameleaf_render_workers_limits_unknown_user') },
                })}
              </span>
            {/if}
          </div>
          {#if entry.reason}
            <p class="reason">{$t(refusalReasonKey[entry.reason])}</p>
          {/if}
          {#if entry.operationId}
            <p class="muted mono">
              {$t('frameleaf_render_workers_audit_operation', { values: { id: entry.operationId } })}
            </p>
          {/if}
          {#if entry.detail}
            <dl>
              {#each auditDetailEntries(entry.detail) as [key, value] (key)}
                <dt>{key}</dt>
                <dd>{value}</dd>
              {/each}
            </dl>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</Pane>

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: start;
    justify-content: space-between;
    gap: 0.75rem 1rem;
    margin-bottom: 1rem;
  }
  .head h2 {
    font-size: var(--fl-font-size);
    margin: 0 0 0.25rem;
  }
  .head p {
    margin: 0;
    max-width: 60ch;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .controls {
    display: flex;
    align-items: end;
    gap: 0.5rem;
  }
  .field {
    display: grid;
    gap: 0.25rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .field select {
    padding: 0.4375rem 0.6875rem;
    font: inherit;
    font-size: var(--fl-font-size);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  ol {
    display: grid;
    gap: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  li {
    display: grid;
    gap: 0.25rem;
    padding: 0.625rem 0.875rem;
    font-size: var(--fl-font-size);
  }
  li + li {
    border-top: 1px solid var(--fl-border);
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  time,
  .muted {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .reason {
    margin: 0;
  }
  .mono {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.125rem 0.75rem;
    margin: 0.25rem 0 0;
    font-size: var(--fl-font-small);
  }
  dt {
    color: var(--fl-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .empty {
    margin: 0;
    padding: 1.5rem 0.875rem;
    color: var(--fl-muted);
  }
</style>
