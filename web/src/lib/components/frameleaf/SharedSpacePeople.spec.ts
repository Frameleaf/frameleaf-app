import {
  linkSharedSpacePerson,
  unlinkSharedSpacePerson,
  updatePerson,
  AlbumKind,
  type SharedSpacePersonResponseDto,
  type UserResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { albumFactory } from '@test-data/factories/album-factory';
import { personFactory } from '@test-data/factories/person-factory';
import en from '../../../../../i18n/en.json';
import SharedSpacePeople from './SharedSpacePeople.svelte';

vi.mock('$lib/utils');
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  linkSharedSpacePerson: vi.fn(),
  unlinkSharedSpacePerson: vi.fn(),
  updatePerson: vi.fn(),
}));

const bo = { id: 'bo', name: 'Bo', email: 'bo@example.com' } as unknown as UserResponseDto;

const space = albumFactory.build({ id: 'space-1', albumName: 'Family Space', kind: AlbumKind.Space });

const link = (overrides: Partial<SharedSpacePersonResponseDto>): SharedSpacePersonResponseDto => ({
  id: 'link-1',
  name: 'Grandma',
  assetCount: 12,
  coverAssetId: null,
  linkedAt: '2026-09-20T00:00:00.000Z',
  linkedBy: bo,
  canUnlink: false,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('SharedSpacePeople', () => {
  it("shows the space's own name for someone and who added them", () => {
    render(SharedSpacePeople, { space, linked: [link({})], candidates: [], onChanged: vi.fn() });

    expect(screen.getByText('Grandma')).toBeInTheDocument();
    expect(screen.getByText(/12 items/)).toBeInTheDocument();
    expect(screen.getByText(/Added by Bo/)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_spaces_people_seen_empty)).toBeInTheDocument();
  });

  it('never offers a person the member has hidden', () => {
    const shown = personFactory.build({ id: 'p-shown', name: 'Nan', isHidden: false });
    const hidden = personFactory.build({ id: 'p-hidden', name: 'Secret', isHidden: true });
    render(SharedSpacePeople, { space, linked: [], candidates: [shown, hidden], onChanged: vi.fn() });

    const options = [...screen.getByRole('combobox').querySelectorAll('option')].map((option) => option.value);
    expect(options).toEqual(['', 'p-shown']);
  });

  it('publishes under a name the space keeps, without renaming anyone in the library', async () => {
    const onChanged = vi.fn();
    const person = personFactory.build({ id: 'p-1', name: 'Mum', isHidden: false });
    render(SharedSpacePeople, { space, linked: [], candidates: [person], onChanged });

    await fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'p-1' },
    });
    const name = screen.getByRole('textbox');
    await waitFor(() => expect(name).toHaveValue('Mum'));
    await fireEvent.input(name, { target: { value: 'Grandma' } });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_person_link }));

    await waitFor(() =>
      expect(linkSharedSpacePerson).toHaveBeenCalledWith({
        id: 'space-1',
        sharedSpacePersonLinkDto: { personId: 'p-1', name: 'Grandma' },
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(updatePerson).not.toHaveBeenCalled();
  });

  it('removes a link by its link id, only where the server allows it', async () => {
    render(SharedSpacePeople, {
      space,
      linked: [link({ canUnlink: true }), link({ id: 'link-2', name: 'Uncle', canUnlink: false })],
      candidates: [],
      onChanged: vi.fn(),
    });

    expect(screen.queryByRole('button', { name: "Remove Uncle from this shared space's people" })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: "Remove Grandma from this shared space's people" }));

    await waitFor(() => expect(unlinkSharedSpacePerson).toHaveBeenCalledWith({ id: 'space-1', linkId: 'link-1' }));
    expect(updatePerson).not.toHaveBeenCalled();
  });
});
