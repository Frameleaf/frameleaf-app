import { selectTemporalReference, selectVisualLandmarks } from 'src/utils/landmark-inference.js';

describe('landmark inference', () => {
  const at = new Date('2026-01-01T12:00:00Z');
  const before = { id: 'before', takenAt: new Date('2026-01-01T11:59:00Z'), latitude: 48.8584, longitude: 2.2945 };
  const after = { ...before, id: 'after', takenAt: new Date('2026-01-01T12:02:00Z'), longitude: 2.2946 };

  it('borrows the closest nearby recorded location', () => {
    expect(selectTemporalReference([after, before], at)).toEqual(before);
    expect(selectTemporalReference([after], at)).toEqual(after);
  });

  it('abstains when adjacent locations disagree or the capture is too far away', () => {
    expect(selectTemporalReference([before, { ...after, latitude: 40 }], at)).toBeUndefined();
    expect(selectTemporalReference([before], new Date('2026-01-01T13:00:00Z'))).toBeUndefined();
    expect(selectTemporalReference([], at)).toBeUndefined();
  });

  const neighbour = (id: string, landmarkIds = ['Q243'], distance = 0.05) => ({ id, landmarkIds, distance });

  it('recognises every landmark shared by at least two close independent images', () => {
    expect(selectVisualLandmarks([neighbour('a', ['Q243', 'Q1']), neighbour('b', ['Q243', 'Q2'])])).toEqual({
      landmarkIds: ['Q243'],
      sourceAssetIds: ['a', 'b'],
    });
  });

  it('abstains for one example, weak similarities, or disagreement among the closest images', () => {
    for (const neighbours of [
      [neighbour('a')],
      [neighbour('a'), neighbour('b', ['Q243'], 0.2)],
      [neighbour('a'), neighbour('b', ['Q1'])],
      [neighbour('a'), neighbour('b'), neighbour('c', ['Q1'])],
      [neighbour('a', []), neighbour('b'), neighbour('c')],
    ]) {
      expect(selectVisualLandmarks(neighbours)).toBeUndefined();
    }
  });
});
