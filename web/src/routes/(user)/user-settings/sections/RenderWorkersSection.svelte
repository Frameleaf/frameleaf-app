<script lang="ts">
  /**
   * Render workers (FL-95 `STU-401`): the administrator's view of renderer admission. Enrol a
   * worker identity and hand it its secret once, scope what it may claim, set the instance and
   * per-account ceilings, revoke, and read the audit trail of every admission decision the server
   * made. The server decides everything; this page shows the decisions and edits the inputs.
   * FL-71: a Compute & jobs section of the Command Center; `/admin/render-workers` redirects here.
   */
  import RenderLimitDialog from '$lib/components/frameleaf/RenderLimitDialog.svelte';
  import RenderLimitsPanel from '$lib/components/frameleaf/RenderLimitsPanel.svelte';
  import RenderWorkerAuditPanel from '$lib/components/frameleaf/RenderWorkerAuditPanel.svelte';
  import RenderWorkerFormDialog from '$lib/components/frameleaf/RenderWorkerFormDialog.svelte';
  import RenderWorkerRevokeDialog from '$lib/components/frameleaf/RenderWorkerRevokeDialog.svelte';
  import RenderWorkersPanel from '$lib/components/frameleaf/RenderWorkersPanel.svelte';
  import { handleDeleteRenderUserLimit } from '$lib/services/render-worker.service';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getRenderWorkerLimits,
    listRenderWorkers,
    searchRenderWorkerAudit,
    type RenderWorkerAuditDto,
    type RenderWorkerDto,
    type RenderWorkerLimitDto,
    type RenderWorkerLimitsResponseDto,
  } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { RenderWorkersData } from './loaders';

  type Props = {
    data: RenderWorkersData;
  };

  const { data }: Props = $props();

  let workers: RenderWorkerDto[] = $state(data.workers);
  let limits: RenderWorkerLimitsResponseDto = $state(data.limits);
  let audit: RenderWorkerAuditDto[] = $state(data.audit);
  let auditWorkerId = $state<string | undefined>();
  let refreshing = $state(false);
  let now = $state(new Date());

  type LimitDialog = { scope: 'instance' } | { scope: 'user'; limit?: RenderWorkerLimitDto };
  let workerDialog = $state<{ worker?: RenderWorkerDto } | null>(null);
  let revokeTarget = $state<RenderWorkerDto | null>(null);
  let limitDialog = $state<LimitDialog | null>(null);

  const accountsWithoutLimit = $derived(
    data.users.filter((user) => !user.deletedAt && limits.users.every((limit) => limit.userId !== user.id)),
  );

  // Health is derived from `lastSeenAt` against the clock, so the clock has to tick; the rows
  // themselves are refreshed after every change and every half minute.
  onMount(() => {
    const timer = setInterval(() => {
      now = new Date();
      void refreshWorkers();
    }, 30_000);
    return () => clearInterval(timer);
  });

  const refreshWorkers = async () => {
    try {
      workers = await listRenderWorkers();
    } catch (error) {
      handleError(error, $t('frameleaf_render_workers_unable_to_load'));
    }
  };

  const refreshLimits = async () => {
    try {
      limits = await getRenderWorkerLimits();
    } catch (error) {
      handleError(error, $t('frameleaf_render_workers_unable_to_load'));
    }
  };

  const refreshAudit = async (workerId: string | undefined = auditWorkerId) => {
    auditWorkerId = workerId;
    refreshing = true;
    try {
      audit = await searchRenderWorkerAudit({ take: 100, workerId });
    } catch (error) {
      handleError(error, $t('frameleaf_render_workers_unable_to_load'));
    } finally {
      refreshing = false;
    }
  };

  const onWorkerDialogClose = async (saved?: RenderWorkerDto) => {
    workerDialog = null;
    if (saved) {
      await Promise.all([refreshWorkers(), refreshAudit()]);
    }
  };

  const onRevokeClose = async (revoked: boolean) => {
    revokeTarget = null;
    if (revoked) {
      await Promise.all([refreshWorkers(), refreshAudit()]);
    }
  };

  const onLimitDialogClose = async (saved?: RenderWorkerLimitDto) => {
    limitDialog = null;
    if (saved) {
      await Promise.all([refreshLimits(), refreshAudit()]);
    }
  };

  const removeUserLimit = async (limit: RenderWorkerLimitDto) => {
    if (!limit.userId) {
      return;
    }
    if (await handleDeleteRenderUserLimit(limit.userId)) {
      await Promise.all([refreshLimits(), refreshAudit()]);
    }
  };
</script>

<div class="flex flex-col gap-6">
  <RenderWorkersPanel
    {workers}
    {now}
    onEnrol={() => (workerDialog = {})}
    onEdit={(worker) => (workerDialog = { worker })}
    onRevoke={(worker) => (revokeTarget = worker)}
  />
  <RenderLimitsPanel
    {limits}
    users={data.users}
    onEditInstance={() => (limitDialog = { scope: 'instance' })}
    onAddUser={() => (limitDialog = { scope: 'user' })}
    onEditUser={(limit) => (limitDialog = { scope: 'user', limit })}
    onRemoveUser={(limit) => void removeUserLimit(limit)}
  />
  <RenderWorkerAuditPanel
    entries={audit}
    {workers}
    users={data.users}
    {refreshing}
    onFilter={(workerId) => void refreshAudit(workerId)}
  />
</div>

{#if workerDialog}
  <RenderWorkerFormDialog worker={workerDialog.worker} onClose={(saved) => void onWorkerDialogClose(saved)} />
{/if}
{#if revokeTarget}
  <RenderWorkerRevokeDialog worker={revokeTarget} onClose={(revoked) => void onRevokeClose(revoked)} />
{/if}
{#if limitDialog}
  <RenderLimitDialog
    scope={limitDialog.scope}
    limit={limitDialog.scope === 'user' ? limitDialog.limit : limits.instance}
    users={limitDialog.scope === 'user' && limitDialog.limit ? data.users : accountsWithoutLimit}
    onClose={(saved) => void onLimitDialogClose(saved)}
  />
{/if}
