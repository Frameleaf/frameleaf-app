import { getAllTags, getTagStatistics, type TagResponseDto } from '@frameleaf/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { load } from './+page';

vi.mock('@frameleaf/sdk', () => ({ getAllTags: vi.fn(), getTagStatistics: vi.fn() }));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));
vi.mock('$lib/components/frameleaf/tags/TagLibrary.svelte', () => ({ default: 'TagLibrary' }));
vi.mock('$lib/utils/i18n', () => ({ getFormatter: async () => (key: string) => key }));

const tags = [
  { id: 'trips', name: 'Trips', value: 'Trips' },
  { id: 'rockies', name: 'Rockies', value: 'Trips/Rockies', parentId: 'trips' },
] as TagResponseDto[];

const run = (path?: string) =>
  load({
    url: new URL(`http://localhost/tags${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`),
  } as never);

/** FL-46: the Tags page loads the tags with their counts, and never hints at a tag it cannot show. */
describe('tags page load', () => {
  beforeEach(() => {
    vi.mocked(getAllTags).mockResolvedValue(tags);
    vi.mocked(getTagStatistics).mockResolvedValue([
      {
        id: 'trips',
        count: 1,
        total: 2,
        coverAssetIds: ['a', 'b'],
        startDate: '2026-08-02T00:00:00.000Z',
        endDate: '2026-08-09T00:00:00.000Z',
      },
    ]);
  });

  it('loads the tags and their counts for the overview and for a deep link', async () => {
    await expect(run()).resolves.toMatchObject({ path: '', tags, statistics: [{ id: 'trips' }] });
    await expect(run('Trips/Rockies')).resolves.toMatchObject({ path: 'Trips/Rockies' });
  });

  it('fetches the grid and the viewer only when a tag is chosen (FL-139)', async () => {
    await expect(run()).resolves.toMatchObject({ TagLibrary: undefined });
    await expect(run('Trips')).resolves.toMatchObject({ TagLibrary: 'TagLibrary' });
  });

  it('answers not found for a deleted, renamed-away or suppressed tag', async () => {
    await expect(run('Trips/Gone')).rejects.toMatchObject({ status: 404 });
    await expect(run('Private')).rejects.toMatchObject({ status: 404 });
  });
});
