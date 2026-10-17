import { ClusterGroupService } from 'src/services/cluster-group.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { newTestService } from 'test/utils.js';

const auth = AuthFactory.create();
const setup = () => {
  const { sut, mocks } = newTestService(ClusterGroupService);
  mocks.access.clusterGroupRequest.checkOwnerAccess.mockResolvedValue(new Set(['request']));
  mocks.access.clusterGroup.checkOwnerAccess.mockResolvedValue(new Set(['source']));
  mocks.clusterGroup.withMembershipChange.mockImplementation((_id, change) => change('source'));
  mocks.clusterGroup.getRequest.mockResolvedValue({
    id: 'request',
    userId: auth.user.id,
    clusterGroupId: 'target',
  } as never);
  mocks.clusterGroup.deleteRequest.mockResolvedValue();
  mocks.clusterGroup.hasOtherMembers.mockResolvedValue(true);
  mocks.clusterGroup.create.mockResolvedValue({ id: 'target' } as never);
  return { sut, mocks };
};

it('accepts the locked owned invitation inside the membership transaction', async () => {
  const { sut, mocks } = setup();
  await sut.acceptRequest(auth, 'request');
  expect(mocks.clusterGroup.withMembershipChange).toHaveBeenCalledWith(auth.user.id, expect.any(Function));
  expect(mocks.clusterGroup.getRequest).toHaveBeenCalledWith('request', true);
  expect(mocks.person.reassignCluster).toHaveBeenCalledWith({ userId: auth.user.id, newClusterId: 'target' });
  expect(mocks.user.update).toHaveBeenCalledWith(auth.user.id, { clusterGroupId: 'target' });
  expect(mocks.clusterGroup.deleteRequest).toHaveBeenCalledWith('request');
});

it('does not consume the invitation when a membership update fails', async () => {
  const { sut, mocks } = setup();
  const error = new Error('update failed');
  mocks.user.update.mockRejectedValue(error);
  await expect(sut.acceptRequest(auth, 'request')).rejects.toBe(error);
  expect(mocks.clusterGroup.deleteRequest).not.toHaveBeenCalled();
});

it('rechecks invitation ownership under the transaction', async () => {
  const { sut, mocks } = setup();
  mocks.clusterGroup.getRequest.mockResolvedValue({
    id: 'request',
    userId: 'other',
    clusterGroupId: 'target',
  } as never);
  await expect(sut.acceptRequest(auth, 'request')).rejects.toThrow('another user');
  expect(mocks.person.reassignCluster).not.toHaveBeenCalled();
});

it.each(['last-member', 'changed-group'])('refuses departure for %s before creating a group', async (reason) => {
  const { sut, mocks } = setup();
  if (reason === 'last-member') mocks.clusterGroup.hasOtherMembers.mockResolvedValue(false);
  else mocks.clusterGroup.withMembershipChange.mockImplementation((_id, change) => change('changed'));
  await expect(sut.leave(auth, 'source')).rejects.toThrow();
  expect(mocks.clusterGroup.create).not.toHaveBeenCalled();
  expect(mocks.person.reassignCluster).not.toHaveBeenCalled();
});

it('checks remaining members before moving into the new group', async () => {
  const { sut, mocks } = setup();
  await sut.leave(auth, 'source');
  expect(mocks.clusterGroup.hasOtherMembers).toHaveBeenCalledWith({ clusterGroupId: 'source', userId: auth.user.id });
  expect(mocks.user.update).toHaveBeenCalledWith(auth.user.id, { clusterGroupId: 'target' });
});
