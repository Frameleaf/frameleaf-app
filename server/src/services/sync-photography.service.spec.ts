import { Writable } from 'node:stream';
import { SyncEntityType, SyncRequestType, UserMetadataKey } from 'src/enum.js';
import { SyncService } from 'src/services/sync.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { makeStream, newTestService } from 'test/utils.js';

it('omits private photography metadata from both legacy sync upserts and deletes', async () => {
  const { sut, mocks } = newTestService(SyncService);
  mocks.session.isPendingSyncReset.mockResolvedValue(false);
  mocks.syncCheckpoint.getAll.mockResolvedValue([]);
  mocks.syncCheckpoint.getNow.mockResolvedValue({ nowId: 'now-id' });
  Object.assign(mocks.sync, {
    userMetadata: {
      getDeletes: () =>
        makeStream([
          { id: 'private-delete', key: UserMetadataKey.PhotographyWorkspace, userId: authStub.user1.user.id },
          { id: 'onboarding-delete', key: UserMetadataKey.Onboarding, userId: authStub.user1.user.id },
        ]),
      getUpserts: () =>
        makeStream([
          {
            updateId: 'private-upsert',
            key: UserMetadataKey.PhotographyWorkspace,
            value: {
              shoots: [{ client: 'Private client' }],
              brand: { email: 'private-studio@example.test', logoAssetId: 'private-logo' },
            },
          },
          { updateId: 'onboarding-upsert', key: UserMetadataKey.Onboarding, value: { isOnboarded: true } },
        ]),
    },
  });
  const chunks: string[] = [];
  const response = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  await sut.stream(authStub.user1, response, { types: [SyncRequestType.UserMetadataV1] });
  const delivered = chunks.map((chunk) => JSON.parse(chunk));
  expect(delivered.map(({ type }) => type)).toEqual([
    SyncEntityType.UserMetadataDeleteV1,
    SyncEntityType.UserMetadataV1,
    SyncEntityType.SyncCompleteV1,
  ]);
  expect(chunks.join('')).not.toContain('photography-workspace');
  expect(chunks.join('')).not.toContain('Private client');
  expect(chunks.join('')).not.toContain('private-studio');
  expect(chunks.join('')).not.toContain('private-logo');
  expect(delivered[1].data).toEqual({ key: UserMetadataKey.Onboarding, value: { isOnboarded: true } });
});
