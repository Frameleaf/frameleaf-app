import { RawBuilder, sql } from 'kysely';
import { JobName, QueueName } from 'src/enum.js';
import { libraryChildOrigins } from 'src/queue/library-admission.js';

/** Frozen root membership is the entitlement, not the current handler payload. Preserve a
 * producer's UUID in source metadata and request bookkeeping before pruning may unlink it.
 */
export const frozenRunEntitled = (runId: RawBuilder<string>, source: RawBuilder<string>) => sql<boolean>`
  exists (select 1 from job_selection frozen_entitlement_original where frozen_entitlement_original.id = ${source} and frozen_entitlement_original."capturedAt" is not null and frozen_entitlement_original.state in ('enumerating','ready') and (
    frozen_entitlement_original."runId" = ${runId} or exists (select 1 from job_run_item frozen_entitlement_request
      where frozen_entitlement_request."runId" = ${runId} and frozen_entitlement_request."rootItemKey" is null and frozen_entitlement_request.state != 'cancelled'
        and coalesce(frozen_entitlement_request."libraryProducerId", frozen_entitlement_request."jobId") = coalesce(frozen_entitlement_original."libraryFrozenProducerId", frozen_entitlement_original."producerId"))))`;

export const libraryGenericRootProof = (
  runId: RawBuilder<string>,
  operationId: RawBuilder<string>,
  root?: RawBuilder<string>,
  item?: { selectionId: RawBuilder<string>; itemKey: RawBuilder<string>; stage: RawBuilder<string> },
) => sql<boolean>`exists (
  select 1 from job_selection_lineage root_proof_origin join job_run_item root_proof_child
    on (root_proof_child."runId", root_proof_child."itemKey", root_proof_child.stage) = (root_proof_origin."runId", root_proof_origin."itemKey", root_proof_origin.stage)
    join job_selection root_proof_source on root_proof_source.id = root_proof_child."selectionId" and root_proof_source."sourceKind" = 'library-child'
    join job_selection root_proof_original on root_proof_original.id = root_proof_origin."selectionId" and root_proof_original."sourceKind" = 'frozen'
    join job_selection_run root_proof_membership on root_proof_membership."selectionId" = root_proof_original.id and root_proof_membership."runId" = ${runId}
    where root_proof_source."libraryOperationId" = ${operationId} and not root_proof_origin.superseded
      ${root ? sql`and root_proof_child."rootItemKey" = ${root}` : sql``}
      ${item ? sql`and root_proof_child."selectionId" = ${item.selectionId} and root_proof_child."itemKey" = ${item.itemKey} and root_proof_child.stage = ${item.stage}` : sql``}
      and (${frozenRunEntitled(runId, sql<string>`root_proof_original.id`)})
      and exists (select 1 from job_run_item root_proof_selected where root_proof_selected."selectionId" = root_proof_original.id
        and root_proof_selected."runId" = root_proof_original."runId" and root_proof_selected."rootItemKey" = root_proof_child."rootItemKey" and root_proof_selected.state != 'cancelled'))`;

export const libraryInitialEntitled = (runId: RawBuilder<string>, operationId: RawBuilder<string>) => sql<boolean>`
  ${runId} = ${operationId} or exists (
    select 1 from job_selection_run initial_entitlement_mapping join job_library_source_producer initial_entitlement_link on initial_entitlement_link."selectionId" = initial_entitlement_mapping."selectionId"
      join job_run_item initial_entitlement_request on coalesce(initial_entitlement_request."libraryProducerId", initial_entitlement_request."jobId") = initial_entitlement_link."producerId"
    where initial_entitlement_mapping."selectionId" = ${operationId} and initial_entitlement_mapping."runId" = ${runId} and initial_entitlement_request."runId" = ${runId}
      and initial_entitlement_request."rootItemKey" is null and initial_entitlement_request.state != 'cancelled')`;

export const libraryMembershipEntitled = (runId: RawBuilder<string>, operationId: RawBuilder<string>) => sql<boolean>`
  (${libraryInitialEntitled(runId, operationId)}) or (${libraryGenericRootProof(runId, operationId)})`;

export const libraryRootEntitled = (
  runId: RawBuilder<string>,
  operationId: RawBuilder<string>,
  root: RawBuilder<string>,
  item?: { selectionId: RawBuilder<string>; itemKey: RawBuilder<string>; stage: RawBuilder<string> },
) => sql<boolean>`
  (${libraryInitialEntitled(runId, operationId)}) or (${libraryGenericRootProof(runId, operationId, root, item)})`;

/** A terminal cold header is a retained decision, but never overrides a completed/pruned
 * item or a live admitted execution. Paused ready sources keep their pending payload.
 */
export const libraryOwnerState = (owner: string, header: string, job: string) => sql<string>`case
  when ${sql.ref(`${job}.id`)} is not null then ${sql.ref(`${job}.state`)}
  when ${sql.ref(`${owner}.state`)}='pending' and ${sql.ref(`${header}.state`)} in ('needs_attention','cancelled') then ${sql.ref(`${header}.state`)}
  else ${sql.ref(`${owner}.state`)} end`;

/** Retained physical ownership survives job pruning. Initial sources use their own tuple. */
export const libraryCanonicalState = (
  alias: string,
) => sql<string>`case when ${sql.ref(`${alias}.state`)}='cancelled' then 'cancelled'
  when ${sql.ref(`${alias}.jobId`)} is null and ${sql.ref(`${alias}.state`)}='pending' and exists (select 1 from job_selection local_source
    where local_source.id=${sql.ref(`${alias}.selectionId`)} and local_source.state in ('needs_attention','cancelled'))
    then (select local_source.state from job_selection local_source where local_source.id=${sql.ref(`${alias}.selectionId`)})
  else coalesce((select ${libraryOwnerState('owner', 'owner_source', 'j')}
  from job_run_item owner left join job j on j.id=owner."jobId"
  left join job_selection owner_source on owner_source.id=owner."selectionId"
  where (owner."runId",owner."itemKey",owner.stage)=(coalesce(${sql.ref(`${alias}.libraryExecutionRunId`)},${sql.ref(`${alias}.runId`)}),
    coalesce(${sql.ref(`${alias}.libraryExecutionItemKey`)},${sql.ref(`${alias}.itemKey`)}),${sql.ref(`${alias}.stage`)})),${sql.ref(`${alias}.state`)}) end`;

/** A secondary operation's canonical membership waits for the shared physical owner's
 * admission or terminal decision. It cannot replace a deferred intent or mint another budget.
 */
export const libraryFeederEligible = (
  alias: string,
) => sql<boolean>`(${sql.ref(`${alias}.libraryExecutionRunId`)} is null
  or (${sql.ref(`${alias}.libraryExecutionRunId`)},${sql.ref(`${alias}.libraryExecutionItemKey`)})=(${sql.ref(`${alias}.runId`)},${sql.ref(`${alias}.itemKey`)})
  or exists (select 1 from job_run_item owner left join job j on j.id=owner."jobId"
    left join job_selection owner_source on owner_source.id=owner."selectionId"
    where (owner."runId",owner."itemKey",owner.stage)=
    (${sql.ref(`${alias}.libraryExecutionRunId`)},${sql.ref(`${alias}.libraryExecutionItemKey`)},${sql.ref(`${alias}.stage`)})
    and (owner."jobId" is not null or (${libraryOwnerState('owner', 'owner_source', 'j')}) not in ('pending','waiting','active'))))`;

/** Sparse non-default initial outcomes resolve admitted/pruned owners without a probe for every cold root. */
export const initialCanonicalOutcomeContext = sql`left join job_run_item initial_canonical on snapshot."sourceKind"='library-initial'
    and i.state='pending' and i."jobId" is null and i."runId"!=snapshot."runId"
    and initial_canonical."libraryIntent" is not null
    and (initial_canonical."jobId" is not null or initial_canonical.state!='pending' or initial_canonical."libraryExecutionRunId" is not null)
    and initial_canonical."selectionId"=snapshot.id and initial_canonical."runId"=snapshot."runId"
    and initial_canonical."itemKey"=i."itemKey" and initial_canonical.stage=i.stage`;

/** Producer entitlement is source/run scoped; frozen subset proof remains item scoped elsewhere. */
export const initialSelectionEntitlementRows = (
  runScope: RawBuilder<string>,
) => sql`select initial_scope."runId",initial_scope."selectionId",
      ${libraryInitialEntitled(sql<string>`initial_scope."runId"`, sql<string>`initial_source."libraryOperationId"`)} entitled
    from job_selection_run initial_scope join job_selection initial_source on initial_source.id=initial_scope."selectionId"
    where initial_scope."runId" in (${runScope}) and initial_source."sourceKind"!='frozen'`;

export const initialSelectionEntitlementContext = (runScope: RawBuilder<string>) => sql`left join lateral (
  ${initialSelectionEntitlementRows(runScope)} offset 0) initial_entitlement
  on initial_entitlement."runId"=i."runId" and initial_entitlement."selectionId"=snapshot.id`;

/** Every consumer supplies its run scope, including pet reconciliation's correlated probes.
 * Cold initial aliases need only non-default canonical outcomes; the absent canonical row
 * has the same pending/null-job/null-executor state as the alias. The partial index allows
 * that sparse join without one lookup per cold root. Child/pruned tuples use full ownership.
 * Entitlement is computed per source mapping, while frozen subset proofs stay root-specific.
 */
export const selectionItemContext = (
  runScope: RawBuilder<string>,
  entitlementContext?: RawBuilder<unknown>,
) => sql`from job_run_item i
  left join job_selection snapshot on snapshot.id=i."selectionId"
  ${initialCanonicalOutcomeContext}
  left join lateral (select owner.state,owner."jobId",owner."libraryExecutionRunId",owner."libraryExecutionItemKey" from job_run_item owner
    where (snapshot."sourceKind"='library-child' or (snapshot."sourceKind"='library-initial' and (i.state!='pending' or i."jobId" is not null)))
      and i.state!='cancelled' and i."runId"!=snapshot."runId"
      and owner."selectionId"=snapshot.id and owner."runId"=snapshot."runId"
      and owner."itemKey"=i."itemKey" and owner.stage=i.stage limit 1) other_canonical on true
  left join lateral (select coalesce(initial_canonical.state,other_canonical.state) state,
    coalesce(initial_canonical."jobId",other_canonical."jobId") "jobId",
    coalesce(initial_canonical."libraryExecutionRunId",other_canonical."libraryExecutionRunId") "libraryExecutionRunId",
    coalesce(initial_canonical."libraryExecutionItemKey",other_canonical."libraryExecutionItemKey") "libraryExecutionItemKey") canonical on true
  left join lateral (select executor.state,executor."jobId",executor."selectionId" from job_run_item executor
    where coalesce(canonical."libraryExecutionRunId",i."libraryExecutionRunId") is not null
    and (executor."runId",executor."itemKey",executor.stage)=
    (coalesce(canonical."libraryExecutionRunId",i."libraryExecutionRunId"),coalesce(canonical."libraryExecutionItemKey",i."libraryExecutionItemKey"),i.stage)
    limit 1) executor on true
  left join job_selection executor_source on executor_source.id=executor."selectionId"
  left join lateral (select j.id,j.state,j.queue,j."availableAt",j.attempt,j."retryBaseAttempt",j."dependencyReason",
      j."progressAt",j."startedAt",j."finishedAt",j."parentId" from job j
    where coalesce(executor."jobId",canonical."jobId",i."jobId") is not null
      and j.id=coalesce(executor."jobId",canonical."jobId",i."jobId") limit 1) j on true
  ${entitlementContext ?? initialSelectionEntitlementContext(runScope)}`;

/** Explicit cancellation wins. A pre-feed alias reads its retained canonical outcome even
 * after the detailed job and its payload have been pruned, without an alias-wide write.
 */
export const selectionItemState = sql<string>`case when i.state='cancelled' then 'cancelled'
  when snapshot."sourceKind" != 'frozen' and not (i."runId"=snapshot."libraryOperationId" or coalesce(initial_entitlement.entitled,false) or (${libraryGenericRootProof(sql<string>`i."runId"`, sql<string>`snapshot."libraryOperationId"`, sql<string>`i."rootItemKey"`, { selectionId: sql<string>`i."selectionId"`, itemKey: sql<string>`i."itemKey"`, stage: sql<string>`i.stage` })})) then 'cancelled'
  when snapshot."sourceKind"!='frozen' and coalesce(canonical.state,i.state)='cancelled' then 'cancelled'
  when snapshot."sourceKind"!='frozen' and coalesce(canonical."jobId",i."jobId") is null
    and coalesce(canonical.state,i.state)='pending' and snapshot.state in ('needs_attention','cancelled') then snapshot.state
  when j.id is not null then j.state
  when snapshot."sourceKind"!='frozen' and coalesce(executor.state,canonical.state,i.state)='pending'
    and coalesce(executor_source.state,snapshot.state) in ('needs_attention','cancelled') then coalesce(executor_source.state,snapshot.state)
  when snapshot."sourceKind"!='frozen' then coalesce(executor.state,canonical.state,i.state)
  when i."jobId" is null and i.state='pending' and snapshot.state in ('needs_attention','cancelled') then snapshot.state else i.state end`;

/** Library tail acknowledgement and missing child mappings are derived, so no alias-wide write
 * is required when a canonical page commits. Canonical media identity never counts producers.
 */
export const libraryRunPending = (runId: RawBuilder<string>) => sql<boolean>`
  ${libraryFrozenPending(runId)} or exists (select 1 from job_selection_run m join job_selection s on s.id = m."selectionId"
    where m."runId" = ${runId} and s."sourceKind" != 'frozen' and (${libraryMembershipEntitled(sql<string>`m."runId"`, sql<string>`s."libraryOperationId"`)}) and (
      s.state = 'enumerating' or (s."sourceKind"='library-initial' and s."sourceClosedAt" is null and s.state='needs_attention') or (m."runId" != s."runId" and m."libraryVersion" < s."appendSequence")))
  or exists (select 1 from job_selection_run origin join job_selection child
    on child."libraryOperationId" = origin."selectionId" and child."sourceKind" = 'library-child'
    where origin."runId" = ${runId}
      and (${libraryMembershipEntitled(sql<string>`origin."runId"`, sql<string>`child."libraryOperationId"`)}) and not exists (select 1 from job_selection_run m
      where m."runId" = origin."runId" and m."selectionId" = child.id))
  or exists (select 1 from job_run_item i join job_library_source_producer link on link."producerId" = coalesce(i."libraryProducerId", i."jobId")
    where i."runId" = ${runId} and i."rootItemKey" is null and i.state != 'cancelled'
      and not exists (select 1 from job_selection_run m where m."runId" = i."runId" and m."selectionId" = link."selectionId"))`;

/** Publication marks canonical child rows unproven before commit. A frozen origin immediately
 * sees that work even before the child cursor has recorded its bounded provenance page.
 */
export const libraryFrozenPending = (runId: RawBuilder<string>) => sql<boolean>`
  exists (select 1 from job_selection_run frozen_mapping join job_selection frozen_source on frozen_source.id=frozen_mapping."selectionId"
    where frozen_mapping."runId"=${runId} and frozen_source."sourceKind"='frozen') and (
  exists (select 1 from job_selection_run membership join job_selection original on original.id = membership."selectionId"
    join job_selection_lineage origin on origin."selectionId" = original.id and not origin.superseded
    join job_run_item child on (child."runId", child."itemKey", child.stage) = (origin."runId", origin."itemKey", origin.stage)
    join job_selection source on source.id = child."selectionId" and source."sourceKind" = 'library-child'
    where membership."runId" = ${runId} and original."sourceKind" = 'frozen'
      and (${frozenRunEntitled(runId, sql<string>`original.id`)})
      and exists (select 1 from job_run_item selected where selected."selectionId" = original.id
        and selected."runId" = original."runId" and selected."rootItemKey" = child."rootItemKey" and selected.state != 'cancelled')
      and not exists (select 1 from job_selection_run mapped where mapped."runId" = ${runId} and mapped."selectionId" = source.id))
  or exists (select 1 from job_run_item child join job_selection source on source.id = child."selectionId"
    where source."sourceKind" = 'library-child' and child."runId" = source."runId" and not child."libraryOriginComplete"
      and exists (select 1 from (${libraryChildOrigins(sql<string>`child."libraryParentId"`, sql<string>`child."rootItemKey"`)}) original
        join job_selection_run membership on membership."selectionId" = original.id
        where membership."runId" = ${runId} and (${frozenRunEntitled(runId, sql<string>`original.id`)})
          and exists (select 1 from job_selection original_source join job_run_item selected
            on selected."selectionId" = original_source.id and selected."runId" = original_source."runId"
            where original_source.id = original.id and selected."rootItemKey" = child."rootItemKey" and selected.state != 'cancelled'))))`;

/** A sufficient unfinished proof shared by the cheap publication preflight and full settlement.
 * A retained pending alias whose detailed job is already terminal is not live execution.
 * Keep both existence checks correlated: flattening them can scan all retained terminal jobs
 * for every publication instead of stopping at one live item and its indexed job identity.
 */
export const unfinishedAdmittedRunItems = (runId: RawBuilder<string>) => sql<boolean>`
  exists (select 1 from job_run_item i where i."runId" = ${runId} and i.state in ('pending','waiting','active')
    and (i."selectionId" is null or i."jobId" is not null)
    and not exists (select 1 from job j where j.id = i."jobId" and j.state not in ('pending','waiting','active')
      limit 1 offset 0) limit 1 offset 0)`;

/** Probe per-run headers first. Separate frozen admission from derived library ownership so
 * PostgreSQL can use the sparse pending-manifest index without filtering retained terminal rows.
 */
export const unfinishedRunItems = (runId: RawBuilder<string>) => sql<boolean>`
  ${libraryRunPending(runId)}
  or (${unfinishedAdmittedRunItems(runId)})
  or exists (select 1 from job_selection_run m join job_selection s on s.id = m."selectionId"
    where m."runId" = ${runId} and not m."copyComplete"
      and (s."sourceKind" = 'frozen' or (${libraryMembershipEntitled(sql<string>`m."runId"`, sql<string>`s."libraryOperationId"`)})))
  or exists (select 1 from job_selection_run membership join job_selection snapshot on snapshot.id = membership."selectionId"
    where membership."runId" = ${runId} and snapshot."sourceKind" = 'frozen' and snapshot.state in ('enumerating','ready')
      and (snapshot.state = 'enumerating' or exists (select 1 from (
        select i."itemKey" from job_run_item i
        where i."selectionId" = snapshot.id and i."runId" = membership."runId"
          and i."jobId" is null and i.state = 'pending'
        order by i."itemKey" limit 1 offset 0) pending_manifest)))
  or exists (select 1 from job_selection_run membership join job_selection snapshot on snapshot.id = membership."selectionId"
    where membership."runId" = ${runId} and snapshot."sourceKind" != 'frozen'
      and (${libraryMembershipEntitled(sql<string>`membership."runId"`, sql<string>`snapshot."libraryOperationId"`)}) and snapshot.state in ('enumerating','ready')
      and (snapshot.state = 'enumerating' or exists (select 1 from job_run_item i
        where i."selectionId" = snapshot.id and i."runId" = snapshot."runId"
          and (${libraryRootEntitled(sql<string>`membership."runId"`, sql<string>`snapshot."libraryOperationId"`, sql<string>`i."rootItemKey"`, { selectionId: sql<string>`i."selectionId"`, itemKey: sql<string>`i."itemKey"`, stage: sql<string>`i.stage` })})
          and (${libraryCanonicalState('i')}) in ('pending','waiting','active')))) `;

/** A terminal snapshot has no dispatch work even though its immutable rows retain pending admission state. */
export const unfinishedQueueItems = (queue: string) => {
  // Individual edit retries can be delayed or paused before their next physical job exists.
  // Probe indexed operation kind/status, not retained failed queue history.
  const edits =
    queue === QueueName.Editor
      ? [JobName.AssetEditThumbnailGeneration, JobName.AssetDevelopRender]
      : queue === QueueName.VideoConversion
        ? [JobName.AssetVideoEditGeneration]
        : [];
  return sql<boolean>`
  exists (select 1 from job where queue = ${queue} and state in ('pending','waiting','active'))
  or exists (select 1 from job_run_item where queue = ${queue} and "jobId" is null and "selectionId" is null
    and state in ('pending','waiting','active'))
  or exists (select 1 from job_selection_run m join job_selection s on s.id = m."selectionId"
    where s.queue = ${queue}
      and (s."sourceKind" = 'frozen' or (${libraryMembershipEntitled(sql<string>`m."runId"`, sql<string>`s."libraryOperationId"`)})) and (not m."copyComplete" or (m."runId" != s."runId" and m."libraryVersion" < s."appendSequence")))
  or exists (select 1 from job_selection s where queue = ${queue} and state in ('ready','enumerating')
    and (state = 'enumerating' or exists (select 1 from job_run_item i where i."selectionId" = s.id
      and i."runId" = s."runId" and i."jobId" is null and i.state = 'pending'
        and (s."sourceKind"='frozen' or (${libraryCanonicalState('i')}) in ('pending','waiting','active')))))
  ${
    edits.length > 0
      ? sql`or exists (select 1 from media_operation
    where kind='quick_edit' and status in ('queued','paused','preparing','rendering','validating','cancelling')
      and snapshot->>'executor'='job_queue' and snapshot->'job'->>'name'=any(${edits}::text[]))`
      : sql``
  } `;
};
