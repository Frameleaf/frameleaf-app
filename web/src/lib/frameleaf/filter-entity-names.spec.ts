import { getAlbumInfo, getPerson, getPet, getTagById } from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetEntityNames,
  resetFilterEntityNameCache,
  resolveEntityName,
  resolveEntityNames,
} from './filter-entity-names';

vi.mock('@immich/sdk', () => ({
  getAlbumInfo: vi.fn(),
  getPerson: vi.fn(),
  getPet: vi.fn(),
  getTagById: vi.fn(),
}));

const person = (overrides: Partial<{ name: string; isHidden: boolean }> = {}) => ({
  id: 'person-1',
  name: 'Ada',
  isHidden: false,
  birthDate: null,
  thumbnailPath: '',
  ...overrides,
});

const pet = (overrides: Partial<{ name: string; isHidden: boolean }> = {}) => ({
  id: 'pet-1',
  name: 'Biscuit',
  isHidden: false,
  species: 'dog',
  assetCount: 0,
  birthDate: null,
  createdAt: '',
  updatedAt: '',
  featuredAssetId: null,
  isFavorite: false,
  ...overrides,
});

const tag = (overrides: Partial<{ value: string }> = {}) => ({
  id: 'tag-1',
  name: 'Rockies',
  value: 'Trips/Rockies',
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetFilterEntityNameCache();
});

describe('resolveEntityName', () => {
  it('resolves an album to its name and an unnamed or unreadable album to null (FL-49 chips)', async () => {
    vi.mocked(getAlbumInfo).mockResolvedValueOnce({ id: 'album-1', albumName: 'Rockies 2024' } as never);
    expect(await resolveEntityName('album', 'album-1')).toBe('Rockies 2024');
    vi.mocked(getAlbumInfo).mockResolvedValueOnce({ id: 'album-2', albumName: '  ' } as never);
    expect(await resolveEntityName('album', 'album-2')).toBeNull();
    vi.mocked(getAlbumInfo).mockRejectedValueOnce(new Error('403'));
    expect(await resolveEntityName('album', 'album-3')).toBeNull();
  });

  it('resolves a visible, named person to their name', async () => {
    vi.mocked(getPerson).mockResolvedValue(person({ name: 'Ada' }) as never);
    expect(await resolveEntityName('person', 'person-1')).toBe('Ada');
  });

  it("never surfaces a hidden person's name, even though the lookup succeeded", async () => {
    vi.mocked(getPerson).mockResolvedValue(person({ isHidden: true }) as never);
    expect(await resolveEntityName('person', 'person-1')).toBeNull();
  });

  it('treats an unnamed person the same as an unresolvable one', async () => {
    vi.mocked(getPerson).mockResolvedValue(person({ name: '' }) as never);
    expect(await resolveEntityName('person', 'person-1')).toBeNull();
  });

  it("never surfaces a hidden pet's name, and resolves a visible one", async () => {
    vi.mocked(getPet).mockResolvedValue(pet({ isHidden: true }) as never);
    expect(await resolveEntityName('pet', 'pet-1')).toBeNull();

    vi.mocked(getPet).mockResolvedValue(pet({ name: 'Biscuit', isHidden: false }) as never);
    expect(await resolveEntityName('pet', 'pet-2')).toBe('Biscuit');
  });

  it('resolves a tag to its full nested path', async () => {
    vi.mocked(getTagById).mockResolvedValue(tag({ value: 'Trips/Rockies' }) as never);
    expect(await resolveEntityName('tag', 'tag-1')).toBe('Trips/Rockies');
  });

  it('never throws — a failed or unauthorized lookup resolves to null instead', async () => {
    vi.mocked(getPerson).mockRejectedValue(new Error('403'));
    await expect(resolveEntityName('person', 'person-1')).resolves.toBeNull();
  });

  it('caches a resolved name, calling the endpoint only once per id', async () => {
    vi.mocked(getPerson).mockResolvedValue(person() as never);
    await resolveEntityName('person', 'person-1');
    await resolveEntityName('person', 'person-1');
    expect(getPerson).toHaveBeenCalledTimes(1);
  });
});

describe('resolveEntityNames', () => {
  it('resolves several ids in order, independently', async () => {
    vi.mocked(getPerson).mockImplementation(
      ({ id }) =>
        Promise.resolve(id === 'person-2' ? person({ isHidden: true }) : person({ name: `Name-${id}` })) as never,
    );
    expect(await resolveEntityNames('person', ['person-1', 'person-2', 'person-3'])).toEqual([
      'Name-person-1',
      null,
      'Name-person-3',
    ]);
  });
});

describe('forgetEntityNames (FL-37)', () => {
  it('reads a renamed or hidden person again, leaving other cached names alone', async () => {
    vi.mocked(getPerson)
      .mockResolvedValueOnce(person({ name: 'Ada' }) as never)
      .mockResolvedValueOnce(person({ name: 'Ada Lovelace' }) as never)
      .mockResolvedValueOnce(person({ isHidden: true }) as never);
    vi.mocked(getTagById).mockResolvedValue(tag() as never);
    expect(await resolveEntityName('person', 'person-1')).toBe('Ada');
    await resolveEntityName('tag', 'tag-1');

    forgetEntityNames('person', ['person-1']);
    expect(await resolveEntityName('person', 'person-1')).toBe('Ada Lovelace');
    forgetEntityNames('person', ['person-1']);
    expect(await resolveEntityName('person', 'person-1')).toBeNull();

    await resolveEntityName('tag', 'tag-1');
    expect(getTagById).toHaveBeenCalledTimes(1);
  });
});
