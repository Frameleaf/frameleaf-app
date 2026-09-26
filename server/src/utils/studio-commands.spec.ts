import { describe, expect, it } from 'vitest';
import { FRAME_RATE_NTSC_30, rational } from 'src/utils/rational-time.js';
import {
  STUDIO_ENGINE_REVISION,
  type StudioCommandEnvelope,
  studioBatchCapabilities,
  studioBatchMutatesGraph,
  studioCommandIds,
  studioCommandMirror,
  validateStudioCommandEnvelope,
  validateStudioCommandPayload,
} from 'src/utils/studio-commands.js';

const envelope = (overrides: Record<string, unknown> = {}): unknown => ({
  id: 'clip.split',
  payload: { at: rational(7, 2) },
  revision: 7,
  idempotencyKey: 'key-1',
  issuedAt: 1_758_499_200_000,
  ...overrides,
});

describe('studio command mirror', () => {
  it('is pinned to the Freecut revision the provenance ledger records', () => {
    expect(STUDIO_ENGINE_REVISION).toBe('4d62e8082c5eb387a96275bcbd323d28f6e41a62');
  });

  it('declares a scope, an owner and a payload field for every graph change', () => {
    expect(studioCommandIds.length).toBeGreaterThan(0);
    for (const id of studioCommandIds) {
      const definition = studioCommandMirror[id];
      expect(definition.owner).toMatch(/^FL-\d+$/);
      // Only a command that changes nothing about the project may carry no arguments
      // (`preview.release`, FL-96); every graph change names what it changes.
      if (Object.keys(definition.payload).length === 0) {
        expect(definition.mutatesGraph).toBe(false);
        expect(['preview.release']).toContain(id);
      }
      if (definition.undoable) {
        expect(definition.mutatesGraph).toBe(true);
      }
      if (definition.scope === 'job') {
        expect(definition.mutatesGraph).toBe(false);
      }
    }
  });
});

describe('validateStudioCommandEnvelope', () => {
  it('accepts a well-formed envelope and hands back its definition', () => {
    const result = validateStudioCommandEnvelope(envelope());

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.envelope.id).toBe('clip.split');
      expect(result.definition.mutatesGraph).toBe(true);
    }
  });

  it('refuses an id the catalogue does not publish', () => {
    expect(validateStudioCommandEnvelope(envelope({ id: 'clip.explode' }))).toMatchObject({
      valid: false,
      reason: 'unknown-command',
    });
  });

  it('refuses an envelope whose revision, key or timestamp cannot be trusted', () => {
    for (const bad of [
      { revision: -1 },
      { revision: 1.5 },
      { idempotencyKey: '' },
      { idempotencyKey: 'k'.repeat(129) },
      { issuedAt: NaN },
    ]) {
      expect(validateStudioCommandEnvelope(envelope(bad))).toMatchObject({
        valid: false,
        reason: 'invalid',
      });
    }

    expect(validateStudioCommandEnvelope(null)).toMatchObject({ valid: false, reason: 'invalid' });
  });

  it('refuses a payload that is missing a required field or carries an unknown one', () => {
    expect(validateStudioCommandEnvelope(envelope({ payload: {} }))).toMatchObject({
      valid: false,
      reason: 'invalid-payload',
    });
    expect(validateStudioCommandEnvelope(envelope({ payload: { at: rational(1), sneak: true } }))).toMatchObject({
      valid: false,
      reason: 'invalid-payload',
    });
  });

  it('checks the declared kind of every field it is given', () => {
    expect(validateStudioCommandPayload('clip.split', { at: 'soon' })).toMatchObject({ valid: false });
    expect(validateStudioCommandPayload('clip.split', { at: rational(1), clipIds: ['a', 'b'] })).toEqual({
      valid: true,
    });
    expect(validateStudioCommandPayload('clip.split', { at: rational(1), clipIds: [1] })).toMatchObject({
      valid: false,
    });
  });

  it('insists that an instant, a length and a cadence are exact rationals', () => {
    // A float is what FL-93 removed from this contract: 1001/30000 has no float spelling,
    // so a client that sends 0.03336666 is refused rather than quietly resampled.
    expect(validateStudioCommandPayload('clip.split', { at: 3.5 })).toMatchObject({ valid: false });
    expect(validateStudioCommandPayload('clip.split', { at: { num: 7, den: 2 } })).toEqual({ valid: true });
    // Unreduced and zero-denominator pairs break the invariants the arithmetic relies on.
    expect(validateStudioCommandPayload('clip.split', { at: { num: 14, den: 4 } })).toMatchObject({ valid: false });
    expect(validateStudioCommandPayload('clip.split', { at: { num: 1, den: 0 } })).toMatchObject({ valid: false });
    expect(validateStudioCommandPayload('sequence.add', { name: 'Main film', fps: FRAME_RATE_NTSC_30 })).toEqual({
      valid: true,
    });
    expect(validateStudioCommandPayload('sequence.add', { name: 'Main film', fps: 29.97 })).toMatchObject({
      valid: false,
    });
    expect(
      validateStudioCommandPayload('voiceover.add', { at: rational(8), duration: rational(6), uploadId: 'u' }),
    ).toEqual({ valid: true });
  });

  it('lets an optional field be absent but not malformed', () => {
    expect(validateStudioCommandPayload('clip.trimStart', { clipId: 'c', start: rational(2) })).toEqual({
      valid: true,
    });
    expect(
      validateStudioCommandPayload('clip.trimStart', { clipId: 'c', start: rational(2), ripple: 'yes' }),
    ).toMatchObject({ valid: false });
  });

  it('carries graph-shaped values through unread, including an explicit null', () => {
    // The grade payload is opaque on purpose: an unknown Freecut field inside it must not
    // make the command invalid, and clearing the grade is a real edit.
    expect(
      validateStudioCommandPayload('clip.setGrade', {
        clipId: 'c',
        grade: { look: 'alpine', futureFieldNobodyKnowsYet: [1, null, { deep: true }] },
      }),
    ).toEqual({ valid: true });
    expect(validateStudioCommandPayload('clip.setGrade', { clipId: 'c', grade: null })).toEqual({ valid: true });
  });
});

describe('studio batches', () => {
  const accepted = (value: unknown): StudioCommandEnvelope => {
    const result = validateStudioCommandEnvelope(value);
    if (!result.valid) {
      throw new Error(result.detail);
    }
    return result.envelope;
  };

  it('reports whether a batch needs the write lease and which workers it needs', () => {
    const edit = accepted(envelope());
    const exportJob = accepted(
      envelope({
        id: 'job.enqueueExport',
        payload: {
          sequenceId: 's',
          format: 'MP4',
          colour: 'Preserve source',
          resolution: '2160p',
          destinationId: 'local',
        },
      }),
    );

    const comment = accepted(envelope({ id: 'review.add', payload: { time: rational(2), text: 'Hold' } }));

    expect(studioBatchMutatesGraph([edit])).toBe(true);
    expect(studioBatchMutatesGraph([exportJob])).toBe(false);
    // Review comments are stored beside the graph (FL-89): a reviewer needs no lease for them.
    expect(studioBatchMutatesGraph([comment])).toBe(false);
    expect(studioBatchCapabilities([edit, exportJob])).toEqual(['renderWorker']);
  });
});
