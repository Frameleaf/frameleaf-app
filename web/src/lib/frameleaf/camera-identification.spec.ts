import { cameraCandidateConflicts, parseCameraIdentification } from '$lib/frameleaf/camera-identification';

const recorded = { make: 'A', model: 'one', source: 'original' as const, makeTag: 'Make', modelTag: 'Model' };
const evidence = {
  version: 1,
  recorded,
  alternatives: [{ make: 'B', model: 'two', source: 'sidecar' }],
  suggestion: { method: 'jpeg-signature', signature: 'digest', matches: 'A, B or editor' },
};

describe('camera evidence JSON', () => {
  it('preserves source, conflicts and shared explanatory lookup text', () => {
    const parsed = parseCameraIdentification(evidence)!;
    expect(parsed).toEqual(evidence);
    expect(cameraCandidateConflicts(parsed.recorded, parsed.alternatives[0])).toBe(true);
    expect(cameraCandidateConflicts(parsed.recorded, { make: null, model: 'one', source: 'sidecar' })).toBe(false);
  });
  it.each([
    null,
    {},
    [],
    { ...evidence, version: 2 },
    { ...evidence, recorded: { ...recorded, source: 'inferred' } },
    { ...evidence, alternatives: [{}] },
    { ...evidence, suggestion: { signature: 'digest' } },
    { ...evidence, suggestion: { ...evidence.suggestion, matches: [] } },
    { ...evidence, recorded: { ...recorded, makeTag: 4 } },
  ])('hides malformed unknown metadata: %j', (value) => {
    expect(parseCameraIdentification(value)).toBeNull();
  });
  it('accepts unknown encoding without inventing a match', () => {
    expect(
      parseCameraIdentification({
        version: 1,
        recorded: null,
        alternatives: [],
        suggestion: { method: 'jpeg-signature', signature: 'unknown', matches: null },
      })?.suggestion?.matches,
    ).toBeNull();
  });
});
