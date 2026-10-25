import { sql } from 'kysely';

// An unclaimed row no longer carries its token. Retained attempts, not its state, prove it stopped.
export const stoppedJobAttempts = sql`((j.attempt = 0 or exists (
  select 1 from job_attempt a where a."jobId" = j.id and a.attempt = j.attempt))
  and not exists (select 1 from job_attempt a where a."jobId" = j.id
    and (a.outcome is distinct from 'completed' or a."finishedAt" is null)
    and not exists (select 1 from system_metadata m where m.key = 'frameleaf-attempt-evidence:' || a.token::text
      and m.value->>'jobId' = j.id::text and m.value ? 'stoppedAt')
    and not exists (select 1 from system_metadata m where m.key = 'frameleaf-worker-stopped:' || a."workerId"::text
      and m.value->>'workerId' = a."workerId"::text and m.value ? 'stoppedAt')))`;
