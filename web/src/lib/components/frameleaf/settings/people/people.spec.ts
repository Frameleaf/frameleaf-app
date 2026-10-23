import { UserStatus, type UserAdminResponseDto, type UserPreferencesResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AddPerson from '$lib/components/frameleaf/settings/people/AddPerson.svelte';
import PersonPage from '$lib/components/frameleaf/settings/people/PersonPage.svelte';
import { bytesOfGb, gbOfBytes, spaceChoiceOf, spaceWords } from '$lib/components/frameleaf/settings/people/space';
import en from '../../../../../../../i18n/en.json';

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'admin-1' } } }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { oauth: false, configFile: false } },
}));
vi.mock('$lib/components/frameleaf/AccountSecurityPanel.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/AccountLifecyclePanel.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/DesktopMemberApproval.svelte', () => ({ default: () => {} }));

const user = (overrides: Partial<UserAdminResponseDto> = {}) =>
  ({
    id: 'emma-1',
    name: 'Emma',
    email: 'emma@example.test',
    isAdmin: false,
    quotaSizeInBytes: 200_000_000_000,
    quotaUsageInBytes: 192_400_000_000,
    storageLabel: null,
    status: UserStatus.Active,
    deletedAt: null,
    ...overrides,
  }) as unknown as UserAdminResponseDto;

const preferences = {
  memories: { enabled: true },
  people: { enabled: true },
  folders: { enabled: true },
  tags: { enabled: false },
  ratings: { enabled: true },
  emailNotifications: { enabled: true, albumInvite: true, albumUpdate: false },
} as unknown as UserPreferencesResponseDto;

describe('Users as People (FL-516)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => vi.clearAllMocks());

  it('reads space as a short list with Other… and plain sizes', () => {
    expect(spaceChoiceOf(null)).toBe('none');
    expect(spaceChoiceOf(200)).toBe('200');
    expect(spaceChoiceOf(300)).toBe('other');
    expect(gbOfBytes(200_000_000_000)).toBe(200);
    expect(bytesOfGb(1000)).toBe(1_000_000_000_000);
    expect(spaceWords(1000)).toBe('1 TB');
    expect(spaceWords(192.4)).toBe('192 GB');
  });

  it('opens one person in three parts and saves only what changed in About', async () => {
    sdkMock.updateUserAdmin.mockResolvedValue(user({ quotaSizeInBytes: 500_000_000_000 }));
    render(PersonPage, {
      user: user(),
      preferences,
      sessions: [],
      savePreferences: vi.fn(),
      loadPreferences: vi.fn(),
    });

    expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign-in & security' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What they’ve turned on' })).toBeInTheDocument();
    expect(screen.getByText('Emma has used 192 GB of 200 GB. 8 GB is free.')).toBeInTheDocument();
    expect(screen.getByText('Folders, Ratings')).toBeInTheDocument();
    expect(screen.getByText('Album invites')).toBeInTheDocument();

    await fireEvent.change(screen.getByRole('combobox', { name: 'Space for Emma' }), { target: { value: '500' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(sdkMock.updateUserAdmin).toHaveBeenCalledWith({
      id: 'emma-1',
      userAdminUpdateDto: { quotaSizeInBytes: 500_000_000_000 },
    });
  });

  it('shows their own choices read-only until "Change for them…" is confirmed', async () => {
    render(PersonPage, {
      user: user(),
      preferences,
      sessions: [],
      savePreferences: vi.fn(),
      loadPreferences: vi.fn(),
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Change for them…' }));
    expect(screen.getByText('Change Emma’s own choices?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('adds a person with "Space for new people" and a temporary password shown once', async () => {
    sdkMock.getConfig.mockResolvedValue({ user: { newUserStorageQuota: 200 } } as never);
    sdkMock.createUserAdmin.mockResolvedValue(user({ id: 'alex-1', name: 'Alex' }));
    const onDone = vi.fn();
    render(AddPerson, { onDone });

    expect(await screen.findByText(/Starts from “Space for new people” \(200 GB\)/)).toBeInTheDocument();
    await fireEvent.input(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Alex' } });
    await fireEvent.input(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'alex@example.test' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add person' }));

    expect(sdkMock.createUserAdmin).toHaveBeenCalledWith({
      userAdminCreateDto: expect.objectContaining({
        name: 'Alex',
        email: 'alex@example.test',
        isAdmin: false,
        quotaSizeInBytes: 200_000_000_000,
        shouldChangePassword: true,
        notify: false,
        password: expect.stringMatching(/^[A-Za-z2-9]{14}$/),
      }),
    });
    expect(await screen.findByText('Their temporary password')).toBeInTheDocument();
  });
});
