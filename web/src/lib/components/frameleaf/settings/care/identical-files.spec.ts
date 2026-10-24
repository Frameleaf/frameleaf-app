import { identicalProblems } from '$lib/components/frameleaf/settings/care/identical-files';
import { importCheckView, showsImportCheck } from '$lib/components/frameleaf/settings/care/import-check';

const counts = {
  scanned: 0,
  upgraded: 0,
  registered: 0,
  linked: 0,
  photosMerged: 0,
  filesMovedToUnused: 0,
  bytesMovedToUnused: 0,
  orphansFound: 0,
  orphanDuplicates: 0,
  photosRecovered: 0,
  damaged: 0,
  problems: 0,
};
const status = (overrides: Record<string, unknown> = {}) =>
  ({
    status: 'running',
    stage: 'scan',
    trigger: 'immich-import',
    startedAt: '2026-10-23T14:35:00.000Z',
    finishedAt: null,
    totalOriginals: 1000,
    counts,
    recovered: [],
    problems: [],
    ...overrides,
  }) as never;

describe('identical files (FL-416)', () => {
  it('reads the check’s problems as the two kinds of skipped files, naming a lone file', () => {
    expect(
      identicalProblems([
        { kind: 'missing', assetId: 'a', path: null, detail: null },
        { kind: 'damaged', assetId: null, path: 'upload/u/IMG_1.jpg', detail: null },
        { kind: 'changed', assetId: 'c', path: 'library/u/VID_0098.MOV', detail: null },
        { kind: 'undone', assetId: 'd', path: null, detail: null },
        { kind: 'check-before-merging', assetId: 'e', path: null, detail: null },
      ] as never),
    ).toEqual([
      { kind: 'unreadable', count: 2 },
      { kind: 'changed', count: 1, name: 'VID_0098.MOV' },
    ]);
    expect(identicalProblems([])).toEqual([]);
  });

  it('shows the import card while the check runs and for a week after', () => {
    const now = Date.parse('2026-10-23T15:00:00.000Z');
    expect(showsImportCheck(status(), now)).toBe(true);
    expect(showsImportCheck(status({ trigger: 'manual' }), now)).toBe(false);
    expect(showsImportCheck(status({ status: 'completed', finishedAt: '2026-10-20T15:00:00.000Z' }), now)).toBe(true);
    expect(showsImportCheck(status({ status: 'completed', finishedAt: '2026-10-01T15:00:00.000Z' }), now)).toBe(false);
    expect(showsImportCheck(undefined, now)).toBe(false);
  });

  it('says where the check stands in three steps, with time left from the pace so far', () => {
    const now = Date.parse('2026-10-23T14:55:00.000Z');
    const reading = importCheckView(
      status({ counts: { ...counts, scanned: 500, linked: 2, photosMerged: 3, bytesMovedToUnused: 10 } }),
      now,
    );
    expect(reading).toMatchObject({
      finished: false,
      percent: 42,
      checked: 500,
      total: 1000,
      merged: 5,
      movedBytes: 10,
      minutesLeft: 20,
    });
    expect(reading.steps).toEqual([
      { id: 'read', status: 'running', percent: 50 },
      { id: 'recover', status: 'queued' },
      { id: 'move', status: 'queued' },
    ]);

    const recovering = importCheckView(status({ stage: 'orphans', counts: { ...counts, scanned: 1000 } }), now);
    expect(recovering.steps.map((step) => step.status)).toEqual(['done', 'running', 'queued']);
    expect(recovering.minutesLeft).toBeUndefined();

    const done = importCheckView(
      status({ status: 'completed', stage: 'done', counts: { ...counts, scanned: 1000, photosRecovered: 37 } }),
      now,
    );
    expect(done).toMatchObject({ finished: true, percent: 100, recovered: 37 });
    expect(done.steps.every((step) => step.status === 'done')).toBe(true);
  });
});
