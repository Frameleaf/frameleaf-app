import { RawBuilder, sql } from 'kysely';

/** Only unadmitted pending memberships inherit a snapshot outcome. Claimed/retained jobs own theirs. */
export const selectionItemState = sql<string>`case when i."jobId" is null and i.state = 'pending'
  and snapshot.state in ('needs_attention','cancelled') then snapshot.state else i.state end`;

/** Probe per-run headers first, never repeatedly filter a large terminal manifest's retained rows. */
export const unfinishedRunItems = (runId: RawBuilder<string>) => sql<boolean>`
  exists (select 1 from job_run_item i where i."runId" = ${runId} and i.state in ('pending','waiting','active')
    and (i."selectionId" is null or i."jobId" is not null))
  or exists (select 1 from job_selection_run where "runId" = ${runId} and not "copyComplete")
  or exists (select 1 from job_selection_run membership join job_selection snapshot on snapshot.id = membership."selectionId"
    where membership."runId" = ${runId} and snapshot.state in ('enumerating','ready')
      and (snapshot.state = 'enumerating' or exists (select 1 from job_run_item i
        where i."selectionId" = snapshot.id and i."runId" = membership."runId" and i."jobId" is null and i.state = 'pending'))) `;

/** A terminal snapshot has no dispatch work even though its immutable rows retain pending admission state. */
export const unfinishedQueueItems = (queue: string) => sql<boolean>`
  exists (select 1 from job where queue = ${queue} and state in ('pending','waiting','active'))
  or exists (select 1 from job_run_item where queue = ${queue} and "jobId" is null and "selectionId" is null
    and state in ('pending','waiting','active'))
  or exists (select 1 from job_selection_run m join job_selection s on s.id = m."selectionId"
    where s.queue = ${queue} and not m."copyComplete")
  or exists (select 1 from job_selection s where queue = ${queue} and state in ('ready','enumerating')
    and (state = 'enumerating' or exists (select 1 from job_run_item i where i."selectionId" = s.id
      and i."runId" = s."runId" and i."jobId" is null and i.state = 'pending'))) `;
