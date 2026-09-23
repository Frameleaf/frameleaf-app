import { describe, expect, it } from 'vitest';
import {
  createStudioCommandEnvelope,
  isStudioCommandEnvelope,
  isStudioCommandId,
  isStudioCommandImplemented,
  studioCommandDefinition,
  studioCommandIds,
  studioCommandRegistry,
  studioCommandRejection,
} from './commands';
import { rational } from './rational-time';

describe('studio command vocabulary', () => {
  it('registers exactly the ids it publishes, with no extras', () => {
    expect([...studioCommandRegistry.keys()].sort()).toEqual([...studioCommandIds].sort());
    for (const id of studioCommandIds) {
      expect(studioCommandDefinition(id).id).toBe(id);
    }
  });

  it('publishes the catalogue in sorted order, with no duplicates', () => {
    // The published catalogue, the server mirror and the Dart contract are all generated in
    // this order, so a row added out of order is caught here before CI regenerates them.
    expect([...studioCommandIds]).toEqual([...studioCommandIds].sort());
    expect(new Set(studioCommandIds).size).toBe(studioCommandIds.length);
  });

  it('keeps job submissions off the undo stack and out of the graph', () => {
    for (const id of studioCommandIds) {
      const definition = studioCommandDefinition(id);
      if (definition.scope === 'job') {
        expect(definition.mutatesGraph).toBe(false);
        expect(definition.undoable).toBe(false);
        // Queued work is work on a worker; it may never be offered without one. Cancelling
        // a job is the exception: it must stay available after a worker has gone away.
        if (id.startsWith('job.enqueue')) {
          expect(definition.requiresCapability).toBeDefined();
        }
      }
    }
  });

  it('never marks a command undoable unless it changes the graph', () => {
    for (const id of studioCommandIds) {
      const definition = studioCommandDefinition(id);
      if (definition.undoable) {
        expect(definition.mutatesGraph).toBe(true);
      }
    }
  });

  it('names an owning story for every command so no row is anonymous', () => {
    for (const id of studioCommandIds) {
      expect(studioCommandDefinition(id).owner).toMatch(/^FL-\d+$/);
      expect(studioCommandDefinition(id).prototypeSource).not.toBe('');
    }
  });

  it('claims no editing semantics for the host story itself', () => {
    // FL-88 routes the vocabulary; every row's behaviour belongs to a later story.
    expect(studioCommandIds.filter((id) => isStudioCommandImplemented(id))).toEqual([]);
  });

  it('keeps preview off the graph and off the undo stack, but behind a worker (FL-96)', () => {
    const request = studioCommandDefinition('preview.request');

    // Looking at a frame changes nothing about the project, so it is neither a graph change
    // nor an undo step — but it does need a GPU worker, so it is never offered without one.
    expect(request.scope).toBe('preview');
    expect(request.mutatesGraph).toBe(false);
    expect(request.undoable).toBe(false);
    expect(request.requiresCapability).toBe('gpuWorker');
    expect(studioCommandDefinition('preview.release').mutatesGraph).toBe(false);
  });

  it('keeps review comments off the graph, the lease and the undo stack (FL-89 stores them beside it)', () => {
    // A reviewer holds no lease and may be on an older revision; a comment is a record about
    // the project, never a change to its graph, so neither may gate it.
    for (const id of ['review.add', 'review.remove', 'review.update'] as const) {
      const definition = studioCommandDefinition(id);
      expect(definition.scope).toBe('review');
      expect(definition.mutatesGraph).toBe(false);
      expect(definition.undoable).toBe(false);
    }
  });

  it('recognises only published ids', () => {
    expect(isStudioCommandId('clip.split')).toBe(true);
    expect(isStudioCommandId('clip.explode')).toBe(false);
    expect(isStudioCommandId(42)).toBe(false);
  });
});

describe('studio command envelopes', () => {
  it('accepts a well-formed envelope', () => {
    const envelope = createStudioCommandEnvelope('clip.split', { at: rational(7, 2) }, 7);

    expect(isStudioCommandEnvelope(envelope)).toBe(true);
    expect(envelope.revision).toBe(7);
    expect(envelope.idempotencyKey.length).toBeGreaterThan(0);
  });

  it('rejects envelopes that are malformed, unknown or missing a usable key', () => {
    const base = createStudioCommandEnvelope('clip.split', { at: rational(1) }, 1);

    expect(isStudioCommandEnvelope(null)).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, id: 'clip.explode' })).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, payload: undefined })).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, revision: -1 })).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, revision: 1.5 })).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, idempotencyKey: '' })).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, idempotencyKey: 'k'.repeat(129) })).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, issuedAt: NaN })).toBe(false);
  });

  it('keeps the supplied idempotency key so a retry is recognisable', () => {
    const first = createStudioCommandEnvelope('clip.split', { at: rational(1) }, 1, { idempotencyKey: 'same' });
    const retry = createStudioCommandEnvelope('clip.split', { at: rational(1) }, 1, { idempotencyKey: 'same' });

    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('carries a translatable reason on every rejection, and the revision on a stale one', () => {
    expect(studioCommandRejection('k', 'not-implemented')).toEqual({
      status: 'rejected',
      idempotencyKey: 'k',
      reason: 'not-implemented',
      messageKey: 'frameleaf_studio_command_not_implemented',
    });

    expect(studioCommandRejection('k', 'stale-revision', 9)).toMatchObject({ reason: 'stale-revision', revision: 9 });
  });
});
