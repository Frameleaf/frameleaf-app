import { ConflictException, NotFoundException } from '@nestjs/common';
import type { AlbumChangeRow, AlbumChangeRunRow } from 'src/repositories/album-change-run.repository.js';
import { AlbumChangeRunKind, AlbumChangeRunStatus } from 'src/schema/tables/album-change-run.table.js';
import { AlbumChangeRunService, registerAlbumChangeReverser } from 'src/services/album-change-run.service.js';
import { factory } from 'test/small.factory.js';
import { newTestService, ServiceMocks } from 'test/utils.js';

vi.mock('src/repositories/album.repository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/repositories/album.repository.js')>()),
  lockAlbumHierarchy: vi.fn().mockResolvedValue(undefined),
}));

const calls: { kind: string; seqs: number[] }[] = [];
const fake =
  (kind: string, outcome: { reversed?: number; skipped?: string[]; membershipAlbumIds?: string[] } = {}) =>
  (_tx: unknown, changes: AlbumChangeRow[]) => {
    calls.push({ kind, seqs: changes.map(({ seq }) => seq) });
    return Promise.resolve({
      reversed: outcome.reversed ?? changes.length,
      skipped: outcome.skipped ?? [],
      membershipAlbumIds: outcome.membershipAlbumIds,
    });
  };

registerAlbumChangeReverser('test.first', fake('test.first'));
registerAlbumChangeReverser('test.second', fake('test.second', { skipped: ['Renamed later'] }));
registerAlbumChangeReverser('test.photos', fake('test.photos', { membershipAlbumIds: ['album-1'] }));

const run = (status = AlbumChangeRunStatus.Done): AlbumChangeRunRow => ({
  id: 'run-1',
  userId: 'user-1',
  kind: AlbumChangeRunKind.Merge,
  status,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  undoneAt: null,
  summary: { winnerName: 'Trips' },
});

const change = (seq: number, kind: string, albumId: string | null = 'album-1'): AlbumChangeRow => ({
  runId: 'run-1',
  seq,
  kind,
  albumId,
  assetId: null,
  before: null,
  after: null,
});

describe(AlbumChangeRunService.name, () => {
  let sut: AlbumChangeRunService;
  let mocks: ServiceMocks;
  const auth = factory.auth();

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AlbumChangeRunService));
    calls.length = 0;
    mocks.albumChangeRun.transaction.mockImplementation((fn) => fn({} as never));
    mocks.albumChangeRun.getAlbumMembers.mockResolvedValue([]);
    mocks.album.updateThumbnails.mockResolvedValue(0);
  });

  it('refuses a kind registered twice', () => {
    expect(() => registerAlbumChangeReverser('test.first', fake('test.first'))).toThrow('already has a reverser');
  });

  describe('undoLatest', () => {
    it('walks changes newest first, grouping neighbours of one kind for their reverser', async () => {
      mocks.albumChangeRun.getLatestForUpdate.mockResolvedValue(run());
      mocks.albumChangeRun.getChanges
        .mockResolvedValueOnce([
          change(4, 'test.first'),
          change(3, 'test.first'),
          change(2, 'test.second'),
          change(1, 'test.first'),
        ])
        .mockResolvedValueOnce([]);

      await expect(sut.undoLatest(auth)).resolves.toEqual({ reversed: 4, skipped: ['Renamed later'] });

      expect(calls).toEqual([
        { kind: 'test.first', seqs: [4, 3] },
        { kind: 'test.second', seqs: [2] },
        { kind: 'test.first', seqs: [1] },
      ]);
      expect(mocks.albumChangeRun.markUndone).toHaveBeenCalledWith(expect.anything(), 'run-1');
    });

    it('pages through a long run, continuing below the last change it read', async () => {
      mocks.albumChangeRun.getLatestForUpdate.mockResolvedValue(run());
      mocks.albumChangeRun.getChanges
        .mockResolvedValueOnce([change(6, 'test.first')])
        .mockResolvedValueOnce([change(5, 'test.first')])
        .mockResolvedValueOnce([]);

      await sut.undoLatest(auth);

      expect(mocks.albumChangeRun.getChanges.mock.calls.map(([, beforeSeq]) => beforeSeq)).toEqual([undefined, 6, 5]);
    });

    it('reports each skipped name once', async () => {
      mocks.albumChangeRun.getLatestForUpdate.mockResolvedValue(run());
      mocks.albumChangeRun.getChanges
        .mockResolvedValueOnce([change(3, 'test.second'), change(2, 'test.first'), change(1, 'test.second')])
        .mockResolvedValueOnce([]);

      await expect(sut.undoLatest(auth)).resolves.toMatchObject({ skipped: ['Renamed later'] });
    });

    it('says when there is nothing to undo', async () => {
      mocks.albumChangeRun.getLatestForUpdate.mockResolvedValue(undefined);

      await expect(sut.undoLatest(auth)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('will not touch a run still in progress', async () => {
      mocks.albumChangeRun.getLatestForUpdate.mockResolvedValue(run(AlbumChangeRunStatus.Running));

      await expect(sut.undoLatest(auth)).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.albumChangeRun.getChanges).not.toHaveBeenCalled();
    });

    it('stops rather than half-undoing a change it has no reverser for', async () => {
      mocks.albumChangeRun.getLatestForUpdate.mockResolvedValue(run());
      mocks.albumChangeRun.getChanges.mockResolvedValueOnce([change(1, 'test.unknown')]);

      await expect(sut.undoLatest(auth)).rejects.toThrow('test.unknown');
      expect(mocks.albumChangeRun.markUndone).not.toHaveBeenCalled();
    });

    it('tells members of the albums it touched, once per album, without emailing them', async () => {
      mocks.albumChangeRun.getLatestForUpdate.mockResolvedValue(run());
      mocks.albumChangeRun.getChanges
        .mockResolvedValueOnce([change(2, 'test.first', 'album-1'), change(1, 'test.first', 'album-1')])
        .mockResolvedValueOnce([]);
      mocks.albumChangeRun.getAlbumMembers.mockResolvedValue([
        { albumId: 'album-1', userId: 'user-1' },
        { albumId: 'album-1', userId: 'user-2' },
      ]);

      await sut.undoLatest(auth);

      expect(mocks.album.updateThumbnails).toHaveBeenCalledWith(['album-1']);
      expect(mocks.event.emit).toHaveBeenCalledTimes(1);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumUpdate', {
        id: 'album-1',
        userIds: ['user-1', 'user-2'],
        recipientIds: [],
      });
    });

    it('tells partners following an album whose photos changed', async () => {
      mocks.albumChangeRun.getLatestForUpdate.mockResolvedValue(run());
      mocks.albumChangeRun.getChanges.mockResolvedValueOnce([change(1, 'test.photos')]).mockResolvedValueOnce([]);
      mocks.partnerOrigin.getIdsWithFollowers.mockResolvedValue(['album-1']);

      await sut.undoLatest(auth);

      expect(mocks.partnerOrigin.getIdsWithFollowers).toHaveBeenCalledWith('album', ['album-1']);
      expect(mocks.job.queueAll).toHaveBeenCalled();
    });
  });

  describe('getLatest', () => {
    it('says Undo is available for a finished run', async () => {
      mocks.albumChangeRun.getLatest.mockResolvedValue(run());

      await expect(sut.getLatest(auth)).resolves.toEqual({
        run: {
          id: 'run-1',
          kind: AlbumChangeRunKind.Merge,
          status: AlbumChangeRunStatus.Done,
          createdAt: '2026-11-01T00:00:00.000Z',
          canUndo: true,
          summary: { winnerName: 'Trips' },
        },
      });
    });

    it('says Undo is not available while the run is in progress', async () => {
      mocks.albumChangeRun.getLatest.mockResolvedValue(run(AlbumChangeRunStatus.Running));

      await expect(sut.getLatest(auth)).resolves.toMatchObject({ run: { canUndo: false } });
    });

    it('answers with no run when none can be undone', async () => {
      mocks.albumChangeRun.getLatest.mockResolvedValue(undefined);

      await expect(sut.getLatest(auth)).resolves.toEqual({ run: null });
    });
  });
});
