import { ForbiddenException } from '@nestjs/common';
import { StackService } from 'src/services/stack.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newTestService } from 'test/utils.js';

it('requires the internal owner worker before unstack selection', async () => {
  const { sut, mocks } = newTestService(StackService);
  await expect(sut.unstackSelection(authStub.user1, ['stack'], ['asset'], false)).rejects.toBeInstanceOf(
    ForbiddenException,
  );
  expect(mocks.stack.unstackSelection).not.toHaveBeenCalled();
});

it.each([false, true])('publishes only committed stack deletions with sequencing=%s', async (sequenced) => {
  const { sut, mocks } = newTestService(StackService);
  const auth = { ...authStub.user1, system: true };
  mocks.stack.enqueueLocalEffects.mockResolvedValue(0);
  const result = { deletedStackIds: ['deleted'], unstackedAssetIds: ['asset'], lockedAssetIds: ['blocked'] };
  mocks.stack.unstackSelection.mockImplementation((_auth, _stacks, _assets, _elevated, capture) => {
    capture?.(sequenced);
    return Promise.resolve(result);
  });
  expect(await sut.unstackSelection(auth, ['deleted', 'retained'], ['asset', 'blocked'], false)).toEqual(result);
  expect(mocks.stack.unstackSelection).toHaveBeenCalledWith(
    auth,
    ['deleted', 'retained'],
    ['asset', 'blocked'],
    false,
    expect.any(Function),
  );
  if (sequenced) {
    expect(mocks.stack.enqueueLocalEffects).toHaveBeenCalledOnce();
    expect(mocks.event.emit).not.toHaveBeenCalled();
  } else {
    expect(mocks.event.emit).toHaveBeenCalledExactlyOnceWith('StackDeleteAll', {
      stackIds: ['deleted'],
      userId: auth.user.id,
    });
  }
});
