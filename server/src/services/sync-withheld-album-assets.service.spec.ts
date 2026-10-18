import { Writable } from 'node:stream';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
import { SyncService } from 'src/services/sync.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newTestService } from 'test/utils.js';

/**
 * FL-447 (owner rule, October 17, 2026): a device on the cursor album streams that already holds
 * another member's item learns it was withdrawn once the item matches its owner's Locked rules, and
 * gets it back once it stops matching, through a reset; nothing else changes for it.
 */
const WITHHELD = 'FrameleafWithheldAlbumAssetsV1';
const NOTHING = 'd41d8cd98f00b204e9800998ecf8427e';
const then = '00000000-0000-7000-8000-000000000001';
const sessionId = authStub.user1.session!.id;
const userId = authStub.user1.user.id;

function setup(checkpoints: Array<{ type: string; ack: string }>, fingerprints: { now: string; then?: string }) {
  const { sut, mocks } = newTestService(SyncService);
  const getWithheldFingerprint = vi.fn((_userId: string, before?: string) =>
    Promise.resolve(before ? (fingerprints.then ?? fingerprints.now) : fingerprints.now),
  );
  mocks.sync.albumToAsset = { getWithheldFingerprint } as never;
  mocks.session.isPendingSyncReset.mockResolvedValue(false);
  mocks.syncCheckpoint.getAll.mockResolvedValue(checkpoints as never);
  mocks.syncCheckpoint.getNow.mockResolvedValue({ nowId: 'now-id' });
  mocks.syncCheckpoint.upsertAll.mockResolvedValue([] as never);
  const chunks: string[] = [];
  const response = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  const stream = (types = [SyncRequestType.AlbumToAssetsV1]) =>
    sut.stream(authStub.user1, response, { types }).then(() => chunks.map((line) => JSON.parse(line)));
  return { sut, mocks, getWithheldFingerprint, stream };
}

const reset = [{ type: SyncEntityType.SyncResetV1, ack: 'SyncResetV1|reset', data: {} }];

describe('withheld album items on the cursor album streams (FL-447)', () => {
  it('resets a device when an item it could already hold is newly withheld or no longer withheld', async () => {
    const { stream, mocks, getWithheldFingerprint } = setup([{ type: WITHHELD, ack: `${WITHHELD}|${then}|before` }], {
      now: 'after',
    });

    await expect(stream()).resolves.toEqual(reset);
    expect(getWithheldFingerprint).toHaveBeenCalledWith(userId, then);
    // the stored fingerprint stays until the device acknowledges the reset
    expect(mocks.syncCheckpoint.upsertAll).not.toHaveBeenCalled();
  });

  it('does not reset for an item or album added since, and moves the fingerprint forward', async () => {
    const { sut, mocks } = setup([{ type: WITHHELD, ack: `${WITHHELD}|${then}|before` }], {
      now: 'with-new-item',
      then: 'before',
    });

    await expect(
      sut['hasWithheldAlbumAssetsChanged'](userId, sessionId, [SyncRequestType.AlbumAssetsV2], {}, 'now-id'),
    ).resolves.toBe(false);
    await expect(
      sut['hasWithheldAlbumAssetsChanged'](
        userId,
        sessionId,
        [SyncRequestType.AlbumAssetsV2],
        { [WITHHELD]: { type: WITHHELD, updateId: then, extraId: 'before' } } as never,
        'now-id',
      ),
    ).resolves.toBe(false);
    expect(mocks.syncCheckpoint.upsertAll).toHaveBeenLastCalledWith([
      { sessionId, type: WITHHELD, ack: `${WITHHELD}|now-id|with-new-item` },
    ]);
  });

  it('needs no second look when the withheld set is unchanged', async () => {
    const { sut, getWithheldFingerprint } = setup([], { now: 'same' });

    await expect(
      sut['hasWithheldAlbumAssetsChanged'](
        userId,
        sessionId,
        [SyncRequestType.AlbumAssetExifsV1],
        { [WITHHELD]: { type: WITHHELD, updateId: then, extraId: 'same' } } as never,
        'now-id',
      ),
    ).resolves.toBe(false);
    expect(getWithheldFingerprint).toHaveBeenCalledTimes(1);
    expect(getWithheldFingerprint).toHaveBeenCalledWith(userId);
  });

  it('resets once a device that synced album items before the check, while something is withheld from it', async () => {
    const synced = { [SyncEntityType.AlbumToAssetV1]: { type: SyncEntityType.AlbumToAssetV1, updateId: then } };
    const withSomething = setup([], { now: 'something' });
    await expect(
      withSomething.sut['hasWithheldAlbumAssetsChanged'](
        userId,
        sessionId,
        [SyncRequestType.AlbumToAssetsV1],
        synced as never,
        'now-id',
      ),
    ).resolves.toBe(true);

    // nothing withheld, or nothing synced yet: the fingerprint is simply recorded
    const withNothing = setup([], { now: NOTHING });
    await expect(
      withNothing.sut['hasWithheldAlbumAssetsChanged'](
        userId,
        sessionId,
        [SyncRequestType.AlbumToAssetsV1],
        synced as never,
        'now-id',
      ),
    ).resolves.toBe(false);
    await expect(
      withSomething.sut['hasWithheldAlbumAssetsChanged'](
        userId,
        sessionId,
        [SyncRequestType.AlbumToAssetsV1],
        {},
        'now-id',
      ),
    ).resolves.toBe(false);
  });

  it('leaves other streams alone, AlbumAssetAccessV1 included', async () => {
    const { sut, getWithheldFingerprint } = setup([], { now: 'something' });

    await expect(
      sut['hasWithheldAlbumAssetsChanged'](
        userId,
        sessionId,
        [SyncRequestType.AlbumAssetAccessV1, SyncRequestType.AssetsV2],
        {},
        'now-id',
      ),
    ).resolves.toBe(false);
    expect(getWithheldFingerprint).not.toHaveBeenCalled();
  });

  it('never shows the private checkpoint to a device', async () => {
    const { sut } = setup(
      [
        { type: SyncEntityType.AlbumToAssetV1, ack: `AlbumToAssetV1|${then}` },
        { type: WITHHELD, ack: `${WITHHELD}|${then}|before` },
      ],
      { now: NOTHING },
    );

    await expect(sut.getAcks(authStub.user1)).resolves.toEqual([
      { type: SyncEntityType.AlbumToAssetV1, ack: `AlbumToAssetV1|${then}` },
    ]);
  });

  it('refuses the private checkpoint from a device', async () => {
    const { sut } = setup([], { now: NOTHING });

    await expect(sut.setAcks(authStub.user1, { acks: [`${WITHHELD}|${then}|forged`] })).rejects.toThrow(
      `Invalid ack type: ${WITHHELD}`,
    );
  });
});
