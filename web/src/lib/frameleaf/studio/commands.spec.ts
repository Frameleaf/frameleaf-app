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

describe('studio command vocabulary', () => {
  it('registers exactly the ids it publishes, with no extras', () => {
    expect([...studioCommandRegistry.keys()].sort()).toEqual([...studioCommandIds].sort());
    for (const id of studioCommandIds) {
      expect(studioCommandDefinition(id).id).toBe(id);
    }
  });

  it('keeps job submissions off the undo stack and out of the graph', () => {
    for (const id of studioCommandIds) {
      const definition = studioCommandDefinition(id);
      if (definition.scope === 'job') {
        expect(definition.mutatesGraph).toBe(false);
        expect(definition.undoable).toBe(false);
        // A job is work on a worker; it may never be offered without one.
        expect(definition.requiresCapability).toBeDefined();
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

  it('recognises only published ids', () => {
    expect(isStudioCommandId('clip.split')).toBe(true);
    expect(isStudioCommandId('clip.explode')).toBe(false);
    expect(isStudioCommandId(42)).toBe(false);
  });
});

describe('studio command envelopes', () => {
  it('accepts a well-formed envelope', () => {
    const envelope = createStudioCommandEnvelope('clip.split', { at: 3.5 }, 7);

    expect(isStudioCommandEnvelope(envelope)).toBe(true);
    expect(envelope.revision).toBe(7);
    expect(envelope.idempotencyKey.length).toBeGreaterThan(0);
  });

  it('rejects envelopes that are malformed, unknown or missing a usable key', () => {
    const base = createStudioCommandEnvelope('clip.split', { at: 1 }, 1);

    expect(isStudioCommandEnvelope(null)).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, id: 'clip.explode' })).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, payload: undefined })).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, revision: -1 })).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, revision: 1.5 })).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, idempotencyKey: '' })).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, idempotencyKey: 'k'.repeat(129) })).toBe(false);
    expect(isStudioCommandEnvelope({ ...base, issuedAt: Number.NaN })).toBe(false);
  });

  it('keeps the supplied idempotency key so a retry is recognisable', () => {
    const first = createStudioCommandEnvelope('clip.split', { at: 1 }, 1, { idempotencyKey: 'same' });
    const retry = createStudioCommandEnvelope('clip.split', { at: 1 }, 1, { idempotencyKey: 'same' });

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
