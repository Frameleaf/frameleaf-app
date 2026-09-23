import { describe, expect, it } from 'vitest';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import {
  activeOperations,
  createLibrarySession,
  isSnapshotCurrent,
  operationScope,
  reduceLibrarySession,
  toStoredLibrarySession,
  type LibrarySession,
  type LibrarySessionAction,
} from '$lib/frameleaf/library-session';

/**
 * FL-32 adds background bulk operations to the session FL-31 defined. These tests cover only the
 * additions; the selection semantics themselves are covered by `library-session.spec.ts`.
 */
const run = (session: LibrarySession, ...actions: LibrarySessionAction[]) => {
  let current = session;
  for (const action of actions) {
    current = reduceLibrarySession(current, action);
  }
  return current;
};

const favoriteQuery = () => ({ ...emptyDiscoveryQuery(), filter: { isFavorite: { eq: true } } });

describe('scope-bound selection', () => {
  it('takes a snapshot only for an explicit select-everything-matching', () => {
    const session = createLibrarySession();
    expect(reduceLibrarySession(session, { type: 'selection', ids: ['a'] }).selectionSnapshot).toBeUndefined();
    expect(
      reduceLibrarySession(session, { type: 'selection', ids: ['a'], allMatching: true }).selectionSnapshot,
    ).toEqual(session.state);
  });

  it('keeps a snapshot while the query narrows inside the scope and drops it when the scope changes', () => {
    const snapshotted = run(
      createLibrarySession(),
      { type: 'view', patch: { scope: { kind: 'album', id: 'album-1' } } },
      { type: 'selection', ids: ['a', 'b'], allMatching: true },
    );
    expect(isSnapshotCurrent(snapshotted)).toBe(true);

    const narrowed = reduceLibrarySession(snapshotted, { type: 'view', patch: { query: favoriteQuery() } });
    expect(narrowed.selectionSnapshot).toBeDefined();
    // The snapshot is still the set the user asked for, which is no longer what the view shows.
    expect(isSnapshotCurrent(narrowed)).toBe(false);

    const moved = reduceLibrarySession(snapshotted, { type: 'scope', scope: { kind: 'library' } });
    expect(moved.selectionSnapshot).toBeUndefined();
    expect(moved.selection).toEqual([]);
  });

  it('submits a deep copy, so a later edit cannot reach a running operation', () => {
    const session = run(createLibrarySession(), {
      type: 'selection',
      ids: ['a'],
      allMatching: true,
    });
    const scope = operationScope(session);
    const edited = reduceLibrarySession(session, { type: 'view', patch: { query: favoriteQuery() } });
    expect(scope.query.filter).toEqual({});
    expect(edited.state.query.filter).toEqual({ isFavorite: { eq: true } });
    expect(operationScope(session)).not.toBe(session.selectionSnapshot);
  });
});

describe('background bulk operations', () => {
  const started = (): LibrarySession =>
    run(createLibrarySession(), {
      type: 'operation-start',
      requestId: 'request-1',
      action: 'archive',
      submittedTotal: 4200,
    });

  it('records the count and the scope captured at submit', () => {
    const session = started();
    const [operation] = session.operations;
    expect(operation.status).toBe('resolving');
    expect(operation.submittedTotal).toBe(4200);
    expect(operation.scope).toEqual(session.state);
    expect(operation.scope).not.toBe(session.state);
    expect(activeOperations(session)).toHaveLength(1);
  });

  it('leaves a submitted operation untouched when the filter changes afterwards', () => {
    const session = reduceLibrarySession(started(), { type: 'view', patch: { query: favoriteQuery() } });
    expect(session.operations[0].scope.query.filter).toEqual({});
    expect(session.state.query.filter).toEqual({ isFavorite: { eq: true } });
  });

  it('reuses the request key on a retry instead of starting a second operation', () => {
    const finished = run(started(), {
      type: 'operation-finish',
      requestId: 'request-1',
      succeeded: 3,
      failed: 1,
      skipped: 0,
    });
    const retried = reduceLibrarySession(finished, {
      type: 'operation-start',
      requestId: 'request-1',
      action: 'archive',
    });
    expect(retried.operations).toHaveLength(1);
    expect(retried.operations[0].status).toBe('resolving');
    expect(retried.operations[0].finishedAt).toBeUndefined();
  });

  it('tracks progress and then the per-item outcome counts', () => {
    const session = run(
      started(),
      { type: 'operation-progress', requestId: 'request-1', processed: 500, total: 4200, status: 'running' },
      {
        type: 'operation-finish',
        requestId: 'request-1',
        succeeded: 4100,
        failed: 90,
        skipped: 10,
        failures: [{ id: 'a', reasonKey: 'frameleaf_bulk_reason_no_permission' }],
      },
    );
    const [operation] = session.operations;
    expect(operation.status).toBe('completed');
    expect(operation.processed).toBe(4200);
    expect(operation.failed).toBe(90);
    expect(operation.failures).toEqual([{ id: 'a', reasonKey: 'frameleaf_bulk_reason_no_permission' }]);
    expect(activeOperations(session)).toEqual([]);
  });

  it('ignores progress that arrives after the operation ended', () => {
    const finished = run(started(), {
      type: 'operation-finish',
      requestId: 'request-1',
      succeeded: 1,
      failed: 0,
      skipped: 0,
      cancelled: true,
    });
    const late = reduceLibrarySession(finished, { type: 'operation-progress', requestId: 'request-1', processed: 99 });
    expect(late.operations[0].status).toBe('cancelled');
    expect(late.operations[0].processed).toBe(1);
  });

  it('bounds the failure list and the history', () => {
    const failures = Array.from({ length: 250 }, (_, index) => ({ id: `asset-${index}` }));
    const session = run(started(), {
      type: 'operation-finish',
      requestId: 'request-1',
      succeeded: 0,
      failed: 250,
      skipped: 0,
      failures,
    });
    expect(session.operations[0].failures).toHaveLength(100);
    expect(session.operations[0].failed).toBe(250);

    let many = createLibrarySession();
    for (let index = 0; index < 25; index++) {
      many = reduceLibrarySession(many, { type: 'operation-start', requestId: `r${index}`, action: 'favorite' });
    }
    expect(many.operations).toHaveLength(20);
    expect(many.operations[0].requestId).toBe('r24');
  });

  it('dismisses a finished operation and ignores an unknown id', () => {
    const session = started();
    expect(reduceLibrarySession(session, { type: 'operation-dismiss', requestId: 'nope' })).toBe(session);
    expect(reduceLibrarySession(session, { type: 'operation-dismiss', requestId: 'request-1' }).operations).toEqual([]);
  });

  it('never persists operations or the selection across a reload', () => {
    const stored = toStoredLibrarySession(started());
    expect(JSON.stringify(stored)).not.toContain('operations');
    expect(createLibrarySession().operations).toEqual([]);
  });
});
