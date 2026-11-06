<script lang="ts">
  /**
   * Render workers (FL-95 `STU-401`): the administrator's view of renderer admission. Enrol a
   * worker identity and hand it its secret once, scope what it may claim, set the instance and
   * per-account ceilings, revoke, and read the audit trail of every admission decision the server
   * made. The server decides everything; this page shows the decisions and edits the inputs.
   * FL-71: a Compute & jobs section of the Command Center; `/admin/render-workers` redirects here.
   *
   * Computers › Advanced (prototype `WorkV3.jsx` ComputersAdvanced) draws it in three parts that share
   * one `RenderWorkersState`: `helpers` (enrol, edit, revoke; under Each computer's technical details),
   * `limits` (the "Limits for each person" section) and `history` (the "History" section, with the full
   * record and its filter behind a disclosure). Without a part, everything as it was.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import RenderLimitDialog from '$lib/components/frameleaf/RenderLimitDialog.svelte';
  import RenderLimitsPanel from '$lib/components/frameleaf/RenderLimitsPanel.svelte';
  import RenderWorkerAuditPanel from '$lib/components/frameleaf/RenderWorkerAuditPanel.svelte';
  import RenderWorkerFormDialog from '$lib/components/frameleaf/RenderWorkerFormDialog.svelte';
  import RenderWorkerRevokeDialog from '$lib/components/frameleaf/RenderWorkerRevokeDialog.svelte';
  import RenderWorkersPanel from '$lib/components/frameleaf/RenderWorkersPanel.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import HistoryList from '$lib/components/frameleaf/settings/kit/HistoryList.svelte';
  import HistoryRow from '$lib/components/frameleaf/settings/kit/HistoryRow.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { auditEventIsRefusal, bytesToGB, msToMinutes, refusalReasonKey } from '$lib/frameleaf/render-workers';
  import { handleDeleteRenderUserLimit } from '$lib/services/render-worker.service';
  import { locale } from '$lib/stores/preferences.store';
  import { RenderWorkerAuditEvent, type RenderWorkerDto, type RenderWorkerLimitDto } from '@frameleaf/sdk';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import type { RenderWorkersData } from './loaders';
  import { RenderWorkersState } from './render-workers-state.svelte';

  type Props = {
    data: RenderWorkersData;
    /** Which part of Computers › Advanced to draw; without one, the whole manager. */
    part?: 'all' | 'helpers' | 'limits' | 'history';
    /** The state the parts share; made here when the manager is drawn whole. */
    store?: RenderWorkersState;
    /** Raise this number to open the "connect a Studio helper" form from the Computers page (FL-364). */
    enrolRequest?: number;
    /** Called when a helper is added, changed or removed, so the page's list can follow. */
    onChanged?: () => void;
  };

  const { data, part = 'all', store: given, enrolRequest = 0, onChanged }: Props = $props();

  // svelte-ignore state_referenced_locally (the store and the data it starts from are fixed for the page)
  const store = given ?? new RenderWorkersState(data, () => $t('frameleaf_render_workers_unable_to_load'));

  type LimitDialog = { scope: 'instance' } | { scope: 'user'; limit?: RenderWorkerLimitDto };
  let workerDialog = $state<{ worker?: RenderWorkerDto } | null>(null);
  let revokeTarget = $state<RenderWorkerDto | null>(null);
  let limitDialog = $state<LimitDialog | null>(null);

  const accountsWithoutLimit = $derived(
    data.users.filter((user) => !user.deletedAt && store.limits.users.every((limit) => limit.userId !== user.id)),
  );
  const byId = $derived(new Map(data.users.map((user) => [user.id, user])));
  const workerName = $derived(new Map(store.workers.map((worker) => [worker.id, worker.name])));

  // Only the part that lists the helpers keeps them fresh; the other parts read the same state.
  onMount(() => (part === 'all' || part === 'helpers' ? store.poll() : undefined));

  const onWorkerDialogClose = async (saved?: RenderWorkerDto) => {
    workerDialog = null;
    if (saved) {
      await Promise.all([store.refreshWorkers(), store.refreshAudit()]);
      onChanged?.();
    }
  };

  const onRevokeClose = async (revoked: boolean) => {
    revokeTarget = null;
    if (revoked) {
      await Promise.all([store.refreshWorkers(), store.refreshAudit()]);
      onChanged?.();
    }
  };
  // Only a request raised while this part is on the page opens the form: Advanced is drawn afresh each
  // time it is shown, and an earlier request must not open it again (FL-1250).
  // svelte-ignore state_referenced_locally (the request already handled when this part was drawn)
  let handledEnrol = enrolRequest;
  $effect(() => {
    if (enrolRequest !== handledEnrol) {
      handledEnrol = enrolRequest;
      if (part !== 'limits' && part !== 'history') {
        workerDialog = {};
      }
    }
  });

  const onLimitDialogClose = async (saved?: RenderWorkerLimitDto) => {
    limitDialog = null;
    if (saved) {
      await Promise.all([store.refreshLimits(), store.refreshAudit()]);
    }
  };

  const removeUserLimit = async (limit: RenderWorkerLimitDto) => {
    if (!limit.userId) {
      return;
    }
    if (await handleDeleteRenderUserLimit(limit.userId)) {
      await Promise.all([store.refreshLimits(), store.refreshAudit()]);
    }
  };

  /** A limit as the end of a sentence: "2 at a time, with no time or size limit". */
  const limitWords = (limit: RenderWorkerLimitDto) => {
    const atOnce =
      limit.maxConcurrentOperations === 0
        ? $t('frameleaf_computers_limits_paused')
        : $t('frameleaf_computers_limits_at_once', { values: { count: limit.maxConcurrentOperations } });
    const minutes = msToMinutes(limit.maxWallClockMs);
    const gb = bytesToGB(limit.maxOutputBytes);
    if (minutes === null && gb === null) {
      return $t('frameleaf_computers_limits_no_ceilings', { values: { atOnce } });
    }
    return $t('frameleaf_computers_limits_ceilings', {
      values: {
        atOnce,
        time:
          minutes === null
            ? $t('frameleaf_computers_limits_no_time')
            : $t('frameleaf_computers_limits_time', { values: { minutes } }),
        size:
          gb === null
            ? $t('frameleaf_computers_limits_no_size')
            : $t('frameleaf_computers_limits_size', { values: { gb } }),
      },
    });
  };
  const personName = (limit: RenderWorkerLimitDto) =>
    (limit.userId ? byId.get(limit.userId)?.name : undefined) ?? $t('frameleaf_render_workers_limits_unknown_user');

  /** What happened, in plain words, for the History list. */
  const HISTORY_EVENT: Record<RenderWorkerAuditEvent, Translations> = {
    [RenderWorkerAuditEvent.Enrolled]: 'frameleaf_computers_history_added',
    [RenderWorkerAuditEvent.Admitted]: 'frameleaf_computers_history_accepted',
    [RenderWorkerAuditEvent.Refused]: 'frameleaf_computers_history_refused',
    [RenderWorkerAuditEvent.ClaimRefused]: 'frameleaf_computers_history_work_refused',
    [RenderWorkerAuditEvent.LimitExceeded]: 'frameleaf_computers_history_stopped',
    [RenderWorkerAuditEvent.Revoked]: 'frameleaf_computers_history_removed',
    [RenderWorkerAuditEvent.Updated]: 'frameleaf_computers_history_changed',
    [RenderWorkerAuditEvent.DeviceLost]: 'frameleaf_computers_history_card_lost',
  };
  const when = (value: string) => DateTime.fromISO(value, { locale: $locale }).toLocaleString(DateTime.DATETIME_MED);
  const HISTORY_SHOWN = 10;
</script>

{#if part === 'all'}
  <div class="flex flex-col gap-6">
    <RenderWorkersPanel
      workers={store.workers}
      now={store.now}
      onEnrol={() => (workerDialog = {})}
      onEdit={(worker) => (workerDialog = { worker })}
      onRevoke={(worker) => (revokeTarget = worker)}
    />
    <RenderLimitsPanel
      limits={store.limits}
      users={data.users}
      onEditInstance={() => (limitDialog = { scope: 'instance' })}
      onAddUser={() => (limitDialog = { scope: 'user' })}
      onEditUser={(limit) => (limitDialog = { scope: 'user', limit })}
      onRemoveUser={(limit) => void removeUserLimit(limit)}
    />
    <RenderWorkerAuditPanel
      entries={store.audit}
      workers={store.workers}
      users={data.users}
      refreshing={store.refreshing}
      onFilter={(workerId) => void store.refreshAudit(workerId)}
    />
  </div>
{:else if part === 'helpers'}
  <RenderWorkersPanel
    workers={store.workers}
    now={store.now}
    onEnrol={() => (workerDialog = {})}
    onEdit={(worker) => (workerDialog = { worker })}
    onRevoke={(worker) => (revokeTarget = worker)}
  />
{:else if part === 'limits'}
  <Section title={$t('frameleaf_computers_limits_title')} description={$t('frameleaf_computers_limits_description')}>
    {#snippet action()}
      <Button disabled={accountsWithoutLimit.length === 0} onclick={() => (limitDialog = { scope: 'user' })}>
        {$t('frameleaf_computers_limits_add')}
      </Button>
    {/snippet}
    <Row
      label={$t('frameleaf_computers_limits_everyone')}
      help={$t('frameleaf_computers_limits_everyone_help', { values: { limit: limitWords(store.limits.instance) } })}
    >
      <Button
        label={$t('frameleaf_computers_limits_change_named', {
          values: { name: $t('frameleaf_computers_limits_everyone') },
        })}
        onclick={() => (limitDialog = { scope: 'instance' })}
      >
        {$t('frameleaf_computers_limits_change')}
      </Button>
    </Row>
    {#each store.limits.users as limit (limit.subject)}
      {@const name = personName(limit)}
      <Row
        label={name}
        help={$t('frameleaf_computers_limits_exception_help', { values: { limit: limitWords(limit) } })}
      >
        <Button
          label={$t('frameleaf_computers_limits_change_named', { values: { name } })}
          onclick={() => (limitDialog = { scope: 'user', limit })}
        >
          {$t('frameleaf_computers_limits_change')}
        </Button>
        <Button
          label={$t('frameleaf_computers_limits_remove_named', { values: { name } })}
          onclick={() => void removeUserLimit(limit)}
        >
          {$t('frameleaf_render_workers_limits_remove')}
        </Button>
      </Row>
    {/each}
  </Section>
{:else if part === 'history'}
  <Section title={$t('frameleaf_computers_history_title')} description={$t('frameleaf_computers_history_description')}>
    {#if store.audit.length === 0}
      <p class="empty">{$t('frameleaf_computers_history_empty')}</p>
    {:else}
      <HistoryList>
        {#each store.audit.slice(0, HISTORY_SHOWN) as entry (entry.id)}
          <HistoryRow
            when={when(entry.createdAt)}
            datetime={entry.createdAt}
            what={entry.workerId
              ? (workerName.get(entry.workerId) ?? $t('frameleaf_render_workers_audit_unknown_worker'))
              : $t('frameleaf_computers_this_server')}
            detail={[
              entry.reason ? $t(refusalReasonKey[entry.reason]) : '',
              entry.actorId
                ? $t('frameleaf_computers_history_by', {
                    values: {
                      name: byId.get(entry.actorId)?.name ?? $t('frameleaf_render_workers_limits_unknown_user'),
                    },
                  })
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <Pill tone={auditEventIsRefusal(entry.event) ? 'warn' : 'good'}>{$t(HISTORY_EVENT[entry.event])}</Pill>
          </HistoryRow>
        {/each}
      </HistoryList>
    {/if}
    <Advanced summary={$t('frameleaf_computers_history_full')}>
      <div class="operator">
        <RenderWorkerAuditPanel
          entries={store.audit}
          workers={store.workers}
          users={data.users}
          refreshing={store.refreshing}
          onFilter={(workerId) => void store.refreshAudit(workerId)}
        />
      </div>
    </Advanced>
  </Section>
{/if}

{#if workerDialog}
  <RenderWorkerFormDialog worker={workerDialog.worker} onClose={(saved) => void onWorkerDialogClose(saved)} />
{/if}
{#if revokeTarget}
  <RenderWorkerRevokeDialog worker={revokeTarget} onClose={(revoked) => void onRevokeClose(revoked)} />
{/if}
{#if limitDialog}
  <RenderLimitDialog
    scope={limitDialog.scope}
    limit={limitDialog.scope === 'user' ? limitDialog.limit : store.limits.instance}
    users={limitDialog.scope === 'user' && limitDialog.limit ? data.users : accountsWithoutLimit}
    onClose={(saved) => void onLimitDialogClose(saved)}
  />
{/if}

<style>
  .empty {
    margin: 0;
    padding: var(--fl-space-4) 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    border-top: 1px solid var(--fl-border);
  }
  /* The full record keeps its own layout, inside the card and never wider than it. */
  .operator {
    min-width: 0;
    max-width: 100%;
    overflow-x: auto;
  }
</style>
