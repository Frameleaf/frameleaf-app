import {
  SuppressionScope,
  type AuthStatusResponseDto,
  type TagResponseDto,
  type UserPreferencesResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LockedRulesPanel from '$lib/components/frameleaf/access/LockedRulesPanel.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { personFactory } from '@test-data/factories/person-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';

const appMocks = vi.hoisted(() => ({
  goto: vi.fn(),
  page: {
    params: {},
    route: { id: '/(user)/user-settings' },
    url: new URL('http://localhost/user-settings?isOpen=suppressed-content'),
  },
}));

vi.mock('$app/navigation', () => ({ goto: appMocks.goto }));
vi.mock('$app/state', () => ({ page: appMocks.page }));
vi.mock('$lib/utils', () => ({
  getPeopleThumbnailUrl: (person: { id: string }) => `/people/${person.id}/thumbnail`,
}));

const tag = (id: string, value: string, parentId?: string): TagResponseDto => ({
  id,
  value,
  name: value.split('/').at(-1) ?? value,
  parentId,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const authStatus = (overrides: Partial<AuthStatusResponseDto> = {}): AuthStatusResponseDto => ({
  isElevated: true,
  password: true,
  pinCode: true,
  ...overrides,
});

const stored = (
  suppression: Partial<UserPreferencesResponseDto['privacy']['suppression']>,
  revision = 'rev-1',
): UserPreferencesResponseDto => ({
  ...preferencesFactory.build(),
  privacy: {
    suppression: { tagIds: [], personIds: [], petIds: [], scope: SuppressionScope.Owned, ...suppression },
  },
  revision,
});

const httpError = (status: number) => Object.assign(new Error(`status ${status}`), { status });

const renderPanel = async () => {
  render(LockedRulesPanel);
  await waitFor(() => expect(sdkMock.getAuthStatus).toHaveBeenCalled());
};

const saveButton = () => screen.getByRole('button', { name: 'frameleaf_locked_rules_save' });

describe('LockedRulesPanel (FL-67)', () => {
  const family = tag('tag-family', 'Family');
  const medical = tag('tag-medical', 'Family/Medical', 'tag-family');
  const receipts = tag('tag-receipts', 'Receipts');

  beforeEach(() => {
    vi.resetAllMocks();
    authManager.setPreferences(preferencesFactory.build());
    sdkMock.getAuthStatus.mockResolvedValue(authStatus());
    sdkMock.getAllTags.mockResolvedValue([family, medical, receipts]);
    sdkMock.getAllPets.mockResolvedValue([]);
    sdkMock.getAllPeople.mockResolvedValue({ people: [], total: 0, hidden: 0, hasNextPage: false });
    sdkMock.getMyPreferences.mockResolvedValue(stored({ tagIds: [family.id] }));
    sdkMock.isHttpError.mockImplementation(
      ((error: unknown) => typeof (error as { status?: unknown } | undefined)?.status === 'number') as never,
    );
  });

  afterEach(() => {
    authManager.reset();
  });

  it('shows nothing about the rules until the session is unlocked', async () => {
    sdkMock.getAuthStatus.mockResolvedValue(authStatus({ isElevated: false }));

    await renderPanel();

    expect(await screen.findByText('frameleaf_locked_rules_locked_description')).toBeInTheDocument();
    expect(sdkMock.getMyPreferences).not.toHaveBeenCalled();
    expect(sdkMock.getAllTags).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_locked_rules_unlock' }));
    expect(appMocks.goto).toHaveBeenCalledWith(
      '/auth/pin-prompt?continue=%2Fuser-settings%3FisOpen%3Dsuppressed-content',
    );
  });

  it('asks for a PIN before anything else when the account has none', async () => {
    sdkMock.getAuthStatus.mockResolvedValue(authStatus({ isElevated: false, pinCode: false }));

    await renderPanel();

    expect(await screen.findByText('frameleaf_locked_rules_set_up_pin')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_locked_rules_pin_settings' }));
    expect(appMocks.goto).toHaveBeenCalledWith('/user-settings?isOpen=user-pin-code-settings');
  });

  it('marks a tag inside a Locked tag as Locked through it', async () => {
    await renderPanel();

    expect(await screen.findByText('Family/Medical')).toBeInTheDocument();
    const nested = screen.getByRole('checkbox', { name: /Family\/Medical/ });
    expect((nested as HTMLInputElement).checked).toBe(true);
    expect(nested.hasAttribute('disabled')).toBe(true);
  });

  it('keeps unavailable people and tags when saving another change, with the loaded revision', async () => {
    sdkMock.getMyPreferences.mockResolvedValue(
      stored({ tagIds: ['tag-deleted', family.id], personIds: ['person-merged'] }, 'rev-4'),
    );
    sdkMock.getPerson.mockRejectedValue(httpError(400));
    sdkMock.updateMyPreferences.mockImplementation(({ userPreferencesUpdateDto }) =>
      Promise.resolve(stored(userPreferencesUpdateDto.privacy!.suppression as never, 'rev-5')),
    );

    await renderPanel();

    expect(await screen.findByText('frameleaf_locked_rules_unavailable_person')).toBeInTheDocument();
    expect(screen.getByText('frameleaf_locked_rules_unavailable_tag')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('checkbox', { name: 'Receipts' }));
    await fireEvent.click(saveButton());

    await waitFor(() =>
      expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: {
          expectedRevision: 'rev-4',
          privacy: {
            suppression: {
              tagIds: ['tag-deleted', family.id, receipts.id],
              personIds: ['person-merged'],
              petIds: [],
              scope: SuppressionScope.Owned,
            },
          },
        },
      }),
    );
    // the session-wide preferences never hold the Locked ids
    expect(authManager.preferences.privacy.suppression.tagIds).toEqual([]);
  });

  it('drops the draft and asks to unlock again when the session locked before the save', async () => {
    await renderPanel();
    await fireEvent.click(await screen.findByRole('checkbox', { name: 'Receipts' }));
    sdkMock.getAuthStatus.mockResolvedValue(authStatus({ isElevated: false }));

    await fireEvent.click(saveButton());

    expect(await screen.findByText('frameleaf_locked_rules_unlock_again')).toBeInTheDocument();
    expect(sdkMock.updateMyPreferences).not.toHaveBeenCalled();
    expect(screen.queryByText('Receipts')).toBeNull();
  });

  it('saves against the new revision when only unrelated preferences changed elsewhere', async () => {
    sdkMock.updateMyPreferences
      .mockRejectedValueOnce(httpError(409))
      .mockResolvedValueOnce(stored({ tagIds: [family.id, receipts.id] }, 'rev-3'));

    await renderPanel();
    await fireEvent.click(await screen.findByRole('checkbox', { name: 'Receipts' }));
    sdkMock.getMyPreferences.mockResolvedValue(stored({ tagIds: [family.id] }, 'rev-2'));
    await fireEvent.click(saveButton());

    await waitFor(() => expect(sdkMock.updateMyPreferences).toHaveBeenCalledTimes(2));
    expect(sdkMock.updateMyPreferences.mock.calls[1][0].userPreferencesUpdateDto.expectedRevision).toBe('rev-2');
    expect(await screen.findByText('frameleaf_locked_rules_saved')).toBeInTheDocument();
  });

  it('keeps the draft and blocks saving when the rules changed in another tab', async () => {
    sdkMock.updateMyPreferences.mockRejectedValueOnce(httpError(409));

    await renderPanel();
    await fireEvent.click(await screen.findByRole('checkbox', { name: 'Receipts' }));
    sdkMock.getMyPreferences.mockResolvedValue(stored({ tagIds: [] }, 'rev-9'));
    await fireEvent.click(saveButton());

    expect(await screen.findByText('frameleaf_locked_rules_conflict')).toBeInTheDocument();
    expect(sdkMock.updateMyPreferences).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('checkbox', { name: 'Receipts' }) as HTMLInputElement).checked).toBe(true);
    expect(saveButton().hasAttribute('disabled')).toBe(true);
  });

  it('adds a person found by name', async () => {
    const alice = personFactory.build({ id: 'person-alice', name: 'Alice' });
    sdkMock.searchPerson.mockResolvedValue([alice]);
    sdkMock.updateMyPreferences.mockResolvedValue(stored({ tagIds: [family.id], personIds: [alice.id] }, 'rev-2'));

    await renderPanel();
    await fireEvent.input(await screen.findByLabelText('frameleaf_locked_rules_find_person'), {
      target: { value: 'Ali' },
    });
    await fireEvent.click(await screen.findByRole('checkbox', { name: 'Alice' }, { timeout: 2000 }));
    await fireEvent.click(saveButton());

    await waitFor(() =>
      expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: expect.objectContaining({
          privacy: { suppression: expect.objectContaining({ personIds: [alice.id] }) },
        }),
      }),
    );
  });

  it("lists the account's people before any search, filtered by the query (UT-26)", async () => {
    const alice = personFactory.build({ id: 'person-alice', name: 'Alice' });
    const bob = personFactory.build({ id: 'person-bob', name: 'Bob' });
    sdkMock.getAllPeople.mockResolvedValue({ people: [alice, bob], total: 2, hidden: 0, hasNextPage: false } as never);

    await renderPanel();
    expect(await screen.findByRole('checkbox', { name: 'Alice' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Bob' })).toBeInTheDocument();

    await fireEvent.input(screen.getByLabelText('frameleaf_locked_rules_find_person'), { target: { value: 'bo' } });
    expect(screen.queryByRole('checkbox', { name: 'Alice' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Bob' })).toBeInTheDocument();
  });

  it('never shows rules the server blanked, even when the status checks passed (load race)', async () => {
    sdkMock.getMyPreferences.mockResolvedValue({
      ...stored({ tagIds: [] }),
      lockedRulesRevealed: false,
    });

    await renderPanel();

    expect(await screen.findByText('frameleaf_locked_rules_unlock_again')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'frameleaf_locked_rules_save' })).toBeNull();
  });

  it('drops the draft when the session locks while the save is in flight', async () => {
    sdkMock.updateMyPreferences.mockRejectedValueOnce(httpError(403));

    await renderPanel();
    await fireEvent.click(await screen.findByRole('checkbox', { name: 'Receipts' }));
    await fireEvent.click(saveButton());

    expect(await screen.findByText('frameleaf_locked_rules_unlock_again')).toBeInTheDocument();
    expect(screen.queryByText('Receipts')).toBeNull();
  });

  it('only a conflict disables Save, as in the template', async () => {
    await renderPanel();
    await screen.findByRole('checkbox', { name: 'Receipts' });
    expect(saveButton().hasAttribute('disabled')).toBe(false);
  });
});
