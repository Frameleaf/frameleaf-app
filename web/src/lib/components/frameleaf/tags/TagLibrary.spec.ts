import type { TagResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { buildTagTree, tagAtPath } from '$lib/frameleaf/tag-tree';
import en from '../../../../../../i18n/en.json';
import TagLibrary from './TagLibrary.svelte';

vi.mock('$lib/components/frameleaf/LibraryView.svelte', async () => ({
  default: (await import('@test-data/frameleaf/LibraryViewStub.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/tags/TagPageHeader.svelte', async () => ({
  default: (await import('@test-data/frameleaf/EmptyStub.svelte')).default,
}));
vi.mock('$lib/components/timeline/TimelineAssetViewer.svelte', async () => ({
  default: (await import('@test-data/frameleaf/EmptyStub.svelte')).default,
}));

const tags = [
  { id: 'trips', name: 'Trips', value: 'Trips' },
  { id: 'rockies', name: 'Rockies', value: 'Trips/Rockies', parentId: 'trips' },
] as TagResponseDto[];
const statistics = [
  { id: 'trips', count: 0, total: 3, coverAssetIds: [], startDate: null, endDate: null },
  { id: 'rockies', count: 3, total: 3, coverAssetIds: [], startDate: null, endDate: null },
];
const tree = buildTagTree(tags, statistics as never);
const options = () => JSON.parse(screen.getByTestId('library-options').textContent ?? '{}');

beforeAll(() => addMessages('dev', en));

// DISCOVERY-P4 (TagsV2.jsx): a tag with tags inside it can show only the items tagged with it itself.
describe('TagLibrary "Include tags inside"', () => {
  it('starts on, and turning it off asks the timeline for the tag itself only', async () => {
    render(TagLibrary, { node: tagAtPath(tree, 'Trips')!, tree, tagOptions: [], onMutated: vi.fn() });

    const toggle = screen.getByRole('button', { name: en.frameleaf_tags_include_inside });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(options()).toEqual({ visibility: 'timeline', tagId: 'trips' });

    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(options()).toEqual({ visibility: 'timeline', tagId: 'trips', withChildTags: false });
    // Nothing is tagged Trips itself: the empty state says where its photos are.
    expect(screen.getByTestId('library-empty')).toHaveTextContent('Nothing is tagged Trips itself');
  });

  it('is not offered on a tag with nothing inside it', () => {
    render(TagLibrary, { node: tagAtPath(tree, 'Trips/Rockies')!, tree, tagOptions: [], onMutated: vi.fn() });

    expect(screen.queryByRole('button', { name: en.frameleaf_tags_include_inside })).toBeNull();
    expect(options()).toEqual({ visibility: 'timeline', tagId: 'rockies' });
  });
});
