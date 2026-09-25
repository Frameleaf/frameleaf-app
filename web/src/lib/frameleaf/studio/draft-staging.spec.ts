import { describe, expect, it } from 'vitest';
import { decideStudioDraft, studioDraftHeld, type StudioDraftGate } from './draft-staging';

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
    expect(studioDraftHeld('conflict')).toBe(true);
    expect(studioDraftHeld('lease-lost')).toBe(true);
    expect(studioDraftHeld('saved')).toBe(false);
    expect(studioDraftHeld(undefined)).toBe(false);
  });
});
