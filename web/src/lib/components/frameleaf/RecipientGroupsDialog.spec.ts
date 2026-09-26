import {
  createRecipientGroup,
  deleteRecipientGroup,
  updateRecipientGroup,
  type RecipientGroupResponseDto,
  type UserResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import RecipientGroupsDialog from './RecipientGroupsDialog.svelte';

vi.mock('$lib/utils');
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  createRecipientGroup: vi.fn(),
  updateRecipientGroup: vi.fn(),
  deleteRecipientGroup: vi.fn(),
}));

const user = (id: string, name: string): UserResponseDto =>
  ({
    id,
    name,
    email: `${id}@example.com`,
    profileImagePath: '',
    avatarColor: 'primary',
    profileChangedAt: '',
  }) as unknown as UserResponseDto;

const bo = user('bo', 'Bo');
const cy = user('cy', 'Cy');
const family: RecipientGroupResponseDto = {
  id: 'group-1',
  name: 'Family',
  users: [bo],
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

/** FL-55: the owner's named recipient shortcuts. */
describe('RecipientGroupsDialog', () => {
  it('says what a group is and is not before anything else', () => {
    render(RecipientGroupsDialog, { open: true, groups: [family], people: [bo, cy], onChanged: vi.fn() });
    expect(screen.getByText(en.frameleaf_recipient_groups_note)).toBeInTheDocument();
    expect(screen.getByText('Family')).toBeInTheDocument();
  });

  it('saves a new named group of the people picked', async () => {
    vi.mocked(createRecipientGroup).mockResolvedValue({ ...family, name: 'Hiking', users: [bo, cy] });
    const onChanged = vi.fn();
    render(RecipientGroupsDialog, { open: true, groups: [], people: [bo, cy], onChanged });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_recipient_groups_new }));
    await fireEvent.input(screen.getByRole('textbox', { name: en.frameleaf_recipient_groups_name }), {
      target: { value: 'Hiking' },
    });
    const list = screen.getByRole('listbox', { name: en.frameleaf_recipient_groups_people });
    await fireEvent.click(within(list).getByRole('option', { name: /Bo/ }));
    await fireEvent.click(within(list).getByRole('option', { name: /Cy/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save group of 2' }));

    await waitFor(() =>
      expect(createRecipientGroup).toHaveBeenCalledWith({
        recipientGroupCreateDto: { name: 'Hiking', userIds: ['bo', 'cy'] },
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('asks for a name instead of saving an unnamed group', async () => {
    render(RecipientGroupsDialog, { open: true, groups: [], people: [bo], onChanged: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_recipient_groups_new }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save group' }));

    expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_recipient_groups_name_required);
    expect(createRecipientGroup).not.toHaveBeenCalled();
  });

  it('edits and deletes a group, and says deleting changes nobody’s access', async () => {
    vi.mocked(updateRecipientGroup).mockResolvedValue({ ...family, users: [bo, cy] });
    vi.mocked(deleteRecipientGroup).mockResolvedValue(undefined as never);
    render(RecipientGroupsDialog, { open: true, groups: [family], people: [bo, cy], onChanged: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Edit Family' }));
    const list = screen.getByRole('listbox', { name: en.frameleaf_recipient_groups_people });
    expect(within(list).getByRole('option', { name: /Bo/ })).toHaveAttribute('aria-selected', 'true');
    await fireEvent.click(within(list).getByRole('option', { name: /Cy/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save group of 2' }));
    await waitFor(() =>
      expect(updateRecipientGroup).toHaveBeenCalledWith({
        id: 'group-1',
        recipientGroupUpdateDto: { name: 'Family', userIds: ['bo', 'cy'] },
      }),
    );

    await fireEvent.click(await screen.findByRole('button', { name: 'Delete Family' }));
    await waitFor(() => expect(deleteRecipientGroup).toHaveBeenCalledWith({ id: 'group-1' }));
    expect(await screen.findByText("Deleted “Family”. Nobody's access changed.")).toBeInTheDocument();
  });
});
