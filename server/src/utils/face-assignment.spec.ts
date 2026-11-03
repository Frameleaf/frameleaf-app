import { assignFaceCandidates } from 'src/utils/face-assignment.js';

const candidate = (faceId: string, overlap: number) => ({ faceId, overlap });

it('reserves the constrained detection while retaining both source identities', () => {
  const result = assignFaceCandidates([[candidate('A', 0.82), candidate('B', 0.56)], [candidate('A', 0.68)]]);
  expect(result).toEqual(
    new Map([
      [0, 'B'],
      [1, 'A'],
    ]),
  );
});

it('reroutes assignments through multiple competing detections', () => {
  expect(
    assignFaceCandidates([
      [candidate('A', 0.9), candidate('B', 0.8)],
      [candidate('B', 0.9), candidate('C', 0.8)],
      [candidate('A', 0.7), candidate('B', 0.6)],
    ]).size,
  ).toBe(3);
});

it('prefers closer candidates when no reassignment is needed', () => {
  expect(assignFaceCandidates([[candidate('B', 0.6), candidate('A', 0.9)]])).toEqual(new Map([[0, 'A']]));
});

it('handles missing candidates without inventing relationships', () => {
  expect(assignFaceCandidates([])).toEqual(new Map());
  expect(assignFaceCandidates([[], [candidate('A', 1)], []])).toEqual(new Map([[1, 'A']]));
});

it('matches the independent exhaustive maximum for every three-by-three graph', () => {
  const maximum = (rows: string[][], index = 0, used = new Set<string>()): number => {
    if (index === rows.length) return 0;
    return Math.max(
      maximum(rows, index + 1, used),
      ...rows[index]
        .filter((faceId) => !used.has(faceId))
        .map((faceId) => 1 + maximum(rows, index + 1, new Set([...used, faceId]))),
    );
  };
  for (let mask = 0; mask < 512; mask++) {
    const rows = Array.from({ length: 3 }, (_, detection) =>
      Array.from({ length: 3 }, (_, face) => face)
        .filter((face) => mask & (1 << (detection * 3 + face)))
        .map((face) => candidate(String(face), 1 - (detection * 3 + face) / 100)),
    );
    const result = assignFaceCandidates(rows);
    expect(result.size, `graph ${mask}`).toBe(maximum(rows.map((row) => row.map(({ faceId }) => faceId))));
    expect(new Set(result.values()).size).toBe(result.size);
    for (const [detection, faceId] of result) expect(rows[detection].some((item) => item.faceId === faceId)).toBe(true);
  }
});

it('handles a 4096-detection reassignment chain without recursion', () => {
  const count = 4096;
  const rows = Array.from({ length: count - 1 }, (_, index) => [
    candidate(String(index), 1),
    candidate(String(index + 1), 0.9),
  ]);
  rows.push([candidate('0', 0.8)]);
  const result = assignFaceCandidates(rows);
  expect(result.size).toBe(count);
  expect(result.get(count - 1)).toBe('0');
  expect(new Set(result.values()).size).toBe(count);
});
