import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StudioWorkspaceService } from 'src/services/studio-workspace.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getMocks } from 'test/utils.js';

describe(StudioWorkspaceService.name, () => {
  let sut: StudioWorkspaceService;
  let repository: Record<'getWorkspace' | 'saveWorkspace' | 'deleteWorkspace', ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    repository = { getWorkspace: vi.fn(), saveWorkspace: vi.fn(), deleteWorkspace: vi.fn() };
    sut = new StudioWorkspaceService(getMocks().logger as never, repository as unknown as StudioProjectRepository);
  });

  it("answers nulls when the account has no layout, and only ever reads the account's own", async () => {
    repository.getWorkspace.mockResolvedValue(undefined);
    await expect(sut.get(authStub.user1)).resolves.toEqual({ layout: null, engineRevision: null, savedAt: null });
    expect(repository.getWorkspace).toHaveBeenCalledWith(authStub.user1.user.id);
  });

  it('stores the layout byte for byte and answers with when it was saved', async () => {
    const layout = { panels: { bin: { open: true, width: 280 } }, zoom: 1.5, unknownFutureField: [null, 1] };
    repository.saveWorkspace.mockResolvedValue({ savedAt: new Date('2026-09-25T12:00:00.000Z') });
    await expect(sut.save(authStub.user1, { layout, engineRevision: 'rev-1' })).resolves.toEqual({
      layout,
      engineRevision: 'rev-1',
      savedAt: '2026-09-25T12:00:00.000Z',
    });
    expect(repository.saveWorkspace).toHaveBeenCalledWith(authStub.user1.user.id, layout, 'rev-1');
  });

  it('says so when nothing could be stored', async () => {
    repository.saveWorkspace.mockResolvedValue(undefined);
    await expect(sut.save(authStub.user1, { layout: {}, engineRevision: 'rev-1' })).rejects.toThrow(
      'cannot be saved right now',
    );
  });

  it('removes the layout with its account', async () => {
    await sut.onUserDelete({ id: 'user-9' } as never);
    expect(repository.deleteWorkspace).toHaveBeenCalledWith('user-9');
  });
});
