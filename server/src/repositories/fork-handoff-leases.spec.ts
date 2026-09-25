import {
  HandoffLeaseSummary,
  assertNoLiveHandoffLeases,
  describeLiveHandoffLeases,
  releaseTransientHandoffLeases,
} from 'src/repositories/fork-handoff-leases.js';
import { ScriptedQuery, scriptedKysely } from 'test/scripted-kysely.js';

const none: HandoffLeaseSummary = {
  operations: [],
  checkpoints: 0,
  renderWorkerSessions: 0,
  studioLeases: 0,
  lapsesAt: null,
};

const leaseAnswer = (options: {
  operations?: Array<{ kind: string; count: number; lapsesAt: Date }>;
  checkpoints?: number;
  sessions?: number;
  studio?: number;
}) => {
  return (query: ScriptedQuery) => {
    if (query.sql.includes('GROUP BY kind')) {
      return { rows: options.operations ?? [] };
    }
    if (query.sql.includes('AS checkpoints')) {
      return {
        rows: [
          {
            checkpoints: options.checkpoints ?? 0,
            renderWorkerSessions: options.sessions ?? 0,
            studioLeases: options.studio ?? 0,
            sessionsLapseAt: options.sessions ? new Date('2026-09-25T10:05:00Z') : null,
            studioLapsesAt: options.studio ? new Date('2026-09-25T10:01:30Z') : null,
          },
        ],
      };
    }
    return { numAffectedRows: 2n };
  };
};

describe('handoff leases (FL-44)', () => {
  it('lets a handoff through when nothing live holds a lease', async () => {
    expect(describeLiveHandoffLeases(none)).toBeNull();
    const { db } = scriptedKysely(leaseAnswer({}));
    await expect(assertNoLiveHandoffLeases(db)).resolves.toBeUndefined();
  });

  it('refuses with every live holder named and when the last lease lapses', async () => {
    const { db } = scriptedKysely(
      leaseAnswer({
        operations: [
          { kind: 'takeout_import', count: 1, lapsesAt: new Date('2026-09-25T10:02:00Z') },
          { kind: 'studio_export', count: 2, lapsesAt: new Date('2026-09-25T10:03:00Z') },
        ],
        checkpoints: 3,
        sessions: 1,
        studio: 1,
      }),
    );

    const refusal = assertNoLiveHandoffLeases(db);
    await expect(refusal).rejects.toThrow(
      'Official handoff refused: 3 jobs are still claimed by a worker (takeout_import x1, studio_export x2, 3 render chunks in flight); 1 render worker is signed in; 1 Studio project is open for editing.',
    );
    await expect(refusal).rejects.toThrow('cancel them in Activity');
    await expect(refusal).rejects.toThrow('The last lease lapses at 2026-09-25T10:05:00.000Z');
  });

  it('counts only unexpired claims, sessions and editor leases, and chunks of a live claim', async () => {
    const { db, queries } = scriptedKysely(leaseAnswer({}));

    await assertNoLiveHandoffLeases(db);

    const statements = queries.map(({ sql }) => sql).join('\n');
    expect(statements).toContain('"claimToken" IS NOT NULL AND "claimExpiresAt" > now()');
    expect(statements).toContain('checkpoint."claimToken" = operation."claimToken"');
    expect(statements).toContain('"revokedAt" IS NULL AND "expiresAt" > now()');
    expect(statements).toContain('"leaseHolderId" IS NOT NULL AND "leaseExpiresAt" > now()');
  });

  it('revokes render-worker sessions and releases Studio leases without touching portable rows', async () => {
    const { db, queries } = scriptedKysely(leaseAnswer({}));

    await expect(releaseTransientHandoffLeases(db)).resolves.toEqual({ renderWorkerSessions: 2, studioLeases: 2 });

    const statements = queries.map(({ sql }) => sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('UPDATE public.render_worker_session SET "revokedAt" = now()');
    expect(statements[1]).toContain('SET "leaseHolderId" = NULL, "leaseClientId" = NULL, "leaseExpiresAt" = NULL');
    expect(statements.join('\n')).not.toMatch(/DELETE|media_operation/);
  });
});
