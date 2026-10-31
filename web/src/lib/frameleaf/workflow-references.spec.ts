import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import {
  clearWorkflowReferenceNames,
  resolveWorkflowReferences,
  searchWorkflowReferences,
} from '$lib/frameleaf/workflow-references';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

const TAG = '7f9a1c2e-1111-4a6b-9c3d-000000000001';
const tag = (value: string) => ({ id: TAG, value, name: value, createdAt: '', updatedAt: '' }) as never;
const signIn = (id: string) => {
  authManager.setUser(userAdminFactory.build({ id }));
  authManager.setPreferences(preferencesFactory.build());
};

describe('workflow reference names (FL-647)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWorkflowReferenceNames();
    signIn('account-a');
  });

  it('reads a chosen name once per account', async () => {
    sdkMock.getTagById.mockResolvedValue(tag('Trip'));
    expect(await resolveWorkflowReferences('TagId', [TAG])).toEqual([{ id: TAG, label: 'Trip' }]);
    expect(await resolveWorkflowReferences('TagId', [TAG])).toEqual([{ id: TAG, label: 'Trip' }]);
    expect(sdkMock.getTagById).toHaveBeenCalledTimes(1);
  });

  it('never answers another account with a name read for the previous one', async () => {
    let finish!: (value: never) => void;
    sdkMock.getTagById.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)) as never);
    const before = resolveWorkflowReferences('TagId', [TAG]);
    // the account changes while the first lookup is still out, and its answer lands afterwards
    signIn('account-b');
    finish(tag('Private to A'));
    await before;

    sdkMock.getTagById.mockRejectedValueOnce(new Error('not found'));
    expect(await resolveWorkflowReferences('TagId', [TAG])).toEqual([]);
    expect(sdkMock.getTagById).toHaveBeenCalledTimes(2);
  });

  it('files search results under the account that searched', async () => {
    let finish!: (value: never) => void;
    sdkMock.searchTags.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)) as never);
    const search = searchWorkflowReferences('TagId', 'pri');
    signIn('account-b');
    finish([tag('Private to A')] as never);
    await search;

    sdkMock.getTagById.mockRejectedValueOnce(new Error('not found'));
    expect(await resolveWorkflowReferences('TagId', [TAG])).toEqual([]);
  });

  it.each(['SessionLocked', 'SessionLockedRemote'] as const)(
    'forgets names read while unlocked on %s, including a lookup still out',
    async (event) => {
      sdkMock.getTagById.mockResolvedValueOnce(tag('Suppressed'));
      expect(await resolveWorkflowReferences('TagId', [TAG])).toEqual([{ id: TAG, label: 'Suppressed' }]);

      let finish!: (value: never) => void;
      sdkMock.searchTags.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)) as never);
      const search = searchWorkflowReferences('TagId', 'sup');
      eventManager.emit(event);
      finish([tag('Suppressed')] as never);
      expect(await search).toEqual([]);

      sdkMock.getTagById.mockRejectedValueOnce(new Error('not found'));
      expect(await resolveWorkflowReferences('TagId', [TAG])).toEqual([]);
    },
  );
});
