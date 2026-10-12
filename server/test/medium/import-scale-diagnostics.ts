import type { KyselyPlugin, QueryId, RawNode } from 'kysely';
import { performance } from 'node:perf_hooks';

type Phase = 'seed' | 'dispatch' | 'counts' | 'share-feed' | 'low-water-update';
type QueryPhase = 'capture' | 'acknowledgement' | 'retained-audit' | 'finish-enumeration' | 'other';

/** Test-only raw transform/result timings; unmatched transforms do not prove SQL execution. */
export const createImportScaleDiagnostics = (
  enabled: boolean,
  write: (line: string) => void = (line) => process.stdout.write(line),
  now: () => number = () => performance.now(),
) => {
  const started = now();
  let active: { phase: string; started: number } | undefined;
  let visit = 0;
  let events = 0;
  const unmatchedTransforms = new Map<QueryId, { phase: QueryPhase; started: number }>();
  const queries: Partial<Record<QueryPhase, { completed: number; totalMs: number; maxMs: number }>> = {};
  const report = (event: string) => {
    if (!enabled || (event !== 'test-failed' && events++ >= 256)) return;
    const time = now();
    write(
      `import-scale-phase ${JSON.stringify({
        event,
        phase: active?.phase ?? 'idle',
        elapsedMs: Math.round(time - started),
        phaseMs: active ? Math.round(time - active.started) : 0,
        visit,
        truncated: events > 256,
        queries,
        unmatchedTransforms: [...unmatchedTransforms.values()].map((query) => ({
          phase: query.phase,
          elapsedMs: Math.round(time - query.started),
        })),
      })}\n`,
    );
  };
  const plugin: KyselyPlugin = {
    transformQuery: ({ node, queryId }) => {
      // Structured selections are embedded without execution; this fixture executes raw outer SQL.
      if (!enabled || node.kind !== 'RawNode') return node;
      const statement = (node as RawNode).sqlFragments.join(' ').trim();
      if (active?.phase === 'share' && statement.startsWith('select paused, "manifestFilling"')) {
        report('phase-end');
        active = { phase: 'feed', started: now() };
        report('phase-start');
      }
      // shortcut: labels match this test's raw SQL; update them when those statements change.
      const phase: QueryPhase = statement.startsWith('insert into job_run_item(')
        ? 'capture'
        : statement.startsWith('update frameleaf_immich_import_work w')
          ? 'acknowledgement'
          : /^select 1 from frameleaf_immich_import_work w\s+where w.dispatched_at is null or not/.test(statement)
            ? 'retained-audit'
            : statement.startsWith('update job_run set "enumerationDone" = true where id =')
              ? 'finish-enumeration'
              : 'other';
      unmatchedTransforms.set(queryId, { phase, started: now() });
      const completed = queries[phase]?.completed ?? 0;
      if (phase !== 'other' && (phase !== 'acknowledgement' || completed % 50 === 0)) report('query-start');
      return node;
    },
    transformResult: async ({ queryId, result }) => {
      const query = unmatchedTransforms.get(queryId);
      if (query) {
        const duration = now() - query.started;
        const metric = (queries[query.phase] ??= { completed: 0, totalMs: 0, maxMs: 0 });
        metric.completed++;
        metric.totalMs += duration;
        metric.maxMs = Math.max(metric.maxMs, duration);
        unmatchedTransforms.delete(queryId);
        if (query.phase !== 'other' && (query.phase !== 'acknowledgement' || metric.completed % 50 === 0)) {
          report('query-progress');
        }
      }
      return result;
    },
  };
  return {
    plugin,
    snapshot: () => report('test-failed'),
    run: async <T>(phase: Phase, work: () => Promise<T>): Promise<T> => {
      if (!enabled) return work();
      if (phase === 'share-feed') visit++;
      active = { phase: phase === 'share-feed' ? 'share' : phase, started: now() };
      report('phase-start');
      try {
        const result = await work();
        report('phase-end');
        return result;
      } catch (error) {
        report('phase-failed');
        throw error;
      } finally {
        active = undefined;
      }
    },
  };
};
