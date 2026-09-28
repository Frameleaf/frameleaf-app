import { describe, expect, it } from 'vitest';
import { decideStudioDraft, studioDraftHeld, studioDraftResult, type StudioDraftGate } from './draft-staging';

const gate = (overrides: Partial<StudioDraftGate> = {}): StudioDraftGate => ({
  accessLost: false,
  forbidden: false,
  authenticated: true,
  access: 'owner',
  status: 'saved',
  ...overrides,
});

describe('editor drafts reaching the host (FL-88, FL-89)', () => {
  it('stages drafts made offline, after losing the lease or during a conflict, so none is dropped', () => {
    for (const status of ['offline', 'lease-lost', 'conflict', 'dirty', 'error', 'saving'] as const) {
      expect(decideStudioDraft(gate({ status }), { id: 'g' })).toEqual({ stage: true });
    }
  });

  it('refuses a draft only when this session may not hold one', () => {
    expect(decideStudioDraft(gate({ accessLost: true }), { id: 'g' })).toMatchObject({
      stage: false,
      result: { reason: 'forbidden' },
    });
    expect(decideStudioDraft(gate({ access: 'reviewer', status: 'review' }), { id: 'g' })).toMatchObject({
      result: { reason: 'lease-lost' },
    });
    expect(decideStudioDraft(gate({ status: 'loading' }), { id: 'g' })).toMatchObject({ stage: false });
    expect(decideStudioDraft(gate(), [1])).toMatchObject({ result: { reason: 'invalid' } });
  });

  it('holds the editor’s edits while a conflict or a lost lease waits for the person', () => {
    expect(studioDraftHeld('conflict', true)).toBe(true);
    expect(studioDraftHeld('lease-lost', true)).toBe(true);
    expect(studioDraftHeld('saved', true)).toBe(false);
    expect(studioDraftHeld('review', true)).toBe(true);
    expect(studioDraftHeld(undefined, false)).toBe(false);
    // After Reload there is no draft to hold, so the editor must show the head it is judged against.
    expect(studioDraftHeld('lease-lost', false)).toBe(false);
    expect(studioDraftHeld('conflict', false)).toBe(false);
  });

  it('tells the editor its draft was superseded by the host’s own graph, and keeps nothing (FL-174)', () => {
    expect(studioDraftResult('superseded', true)).toEqual({ status: 'rejected', reason: 'superseded' });
    expect(studioDraftResult('staged', true)).toEqual({ status: 'staged' });
    expect(studioDraftResult('ignored', false)).toEqual({ status: 'rejected', reason: 'lease-lost' });
    expect(studioDraftResult('staged', false)).toEqual({ status: 'rejected', reason: 'lease-lost' });
  });
});

it('accepts local recovery only for an authorized owner with a known shelved conflict', () => {
  const conflict = { reason: 'project-archived' as const, currentRevision: 3, lease: null };
  expect(decideStudioDraft(gate({ status: 'review', conflict }), { id: 'g' })).toEqual({ stage: true });
  for (const override of [
    { access: 'reviewer' as const },
    { accessLost: true },
    { authenticated: false },
    { forbidden: true },
  ]) {
    expect(decideStudioDraft(gate({ status: 'review', conflict, ...override }), { id: 'g' }).stage).toBe(false);
  }
  expect(decideStudioDraft(gate({ status: 'review' }), { id: 'g' }).stage).toBe(false);
});
