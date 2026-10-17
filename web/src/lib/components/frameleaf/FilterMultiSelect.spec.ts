import { fireEvent, render, screen } from '@testing-library/svelte';
import FilterMultiSelect from './FilterMultiSelect.svelte';

/** FL-31: a chosen value the list no longer offers stays listed and removable. */
describe('FilterMultiSelect', () => {
  it('keeps a selected tag that matches nothing now, and removes it on request', async () => {
    const onChange = vi.fn();
    render(FilterMultiSelect, {
      props: {
        field: 'tagIds',
        anchor: 'tags',
        label: 'Tags',
        options: [{ value: 'tag-1', label: 'Beach', count: 4 }],
        condition: { any: ['tag-1', 'tag-gone'] },
        onChange,
      },
    });

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText('frameleaf_search_unavailable_choice')).toBeInTheDocument();

    await fireEvent.click(boxes[0]);
    expect(onChange).toHaveBeenCalledWith('tagIds', { any: ['tag-1'] });
  });
});
