import { ImageEnrichmentFilter, SearchFacetField, type PersonResponseDto } from '@frameleaf/sdk';
import { fireEvent, screen, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyDiscoveryQuery, type DiscoveryQuery } from '$lib/components/discovery/query';
import { emptyFilterPanelOptions } from '$lib/frameleaf/search-options';
import { renderWithTooltips } from '$tests/helpers';
import FilterPanel from './FilterPanel.svelte';

/** The option names of the listbox a combobox controls. */
const optionNames = (combobox: HTMLElement) =>
  [...document.querySelectorAll(`#${combobox.getAttribute('aria-controls')} [role="option"]`)].map((option) =>
    option.textContent?.trim(),
  );

const JAMIE = '00000000-0000-4000-8000-000000000001';

const options = {
  ...emptyFilterPanelOptions(),
  people: [{ id: JAMIE, name: 'Jamie', thumbnailPath: '/t', updatedAt: '2026-01-01' } as PersonResponseDto],
  cities: ['Banff'],
};

const facets = {
  [SearchFacetField.People]: [{ value: JAMIE, label: 'Jamie', count: 12 }],
  [SearchFacetField.Type]: [
    { value: 'IMAGE', count: 40 },
    { value: 'VIDEO', count: 2 },
  ],
};

describe('FilterPanel', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    Element.prototype.scrollIntoView ??= () => {};
    vi.stubGlobal('visualViewport', null);
  });

  const setup = (query: DiscoveryQuery = emptyDiscoveryQuery(), props: Record<string, unknown> = {}) => {
    const onChange = vi.fn();
    renderWithTooltips(FilterPanel, { query, options, onChange, ...props });
    return { onChange, panel: screen.getByRole('complementary', { name: 'Library filters' }) };
  };

  it('embedded in the search palette, draws no heading and shows live counts', () => {
    const { panel } = setup(emptyDiscoveryQuery(), {
      embedded: true,
      facets,
      enrichmentCounts: { [ImageEnrichmentFilter.MissingImageDescription]: 5 },
    });
    expect(within(panel).queryByRole('heading', { name: 'Filters' })).not.toBeInTheDocument();
    // the count is in the name once, not drawn a second time beside it
    expect(within(panel).getByRole('button', { name: 'Photos (40)' })).toHaveTextContent(/^Photos \(40\)$/);
    expect(within(panel).getByRole('checkbox', { name: /Jamie/ }).closest('label')).toHaveTextContent('12');
    const descriptions = within(panel).getByRole('radiogroup', { name: 'Description' });
    expect(
      within(descriptions)
        .getByRole('radio', { name: /^No description/ })
        .closest('label'),
    ).toHaveTextContent('5');
  });

  it('keeps its heading and capture labels outside the palette', () => {
    const { panel } = setup();
    expect(within(panel).getByRole('heading', { name: 'Filters' })).toBeInTheDocument();
    expect(within(panel).getByLabelText('Captured from')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Captured through')).toBeInTheDocument();
  });

  it('shares the single enrichment value between the description and sensitivity groups', async () => {
    const query = { ...emptyDiscoveryQuery(), imageEnrichment: ImageEnrichmentFilter.NsfwReview };
    const { panel, onChange } = setup(query, { embedded: true });
    const descriptions = within(panel).getByRole('radiogroup', { name: 'Description' });
    const review = within(panel).getByRole('radiogroup', { name: 'Review status' });
    expect(within(descriptions).getByRole('radio', { name: 'Any' })).toBeChecked();
    expect(within(review).getByRole('radio', { name: 'Needs review', checked: true })).toBeInTheDocument();

    // Any in the other group leaves the review choice alone
    await fireEvent.click(within(descriptions).getByRole('radio', { name: 'Any' }));
    expect(onChange).not.toHaveBeenCalled();

    await fireEvent.click(within(descriptions).getAllByRole('radio')[2]);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ imageEnrichment: ImageEnrichmentFilter.ImageDescriptionFailed }),
    );
  });

  /** LIB-09: star counts read as English, "0 stars or more" is gone, and 0 stars is one of the exact counts. */
  it('lists rating choices with correct plurals and no "0 stars or more"', async () => {
    const { panel } = setup();
    const rating = within(panel).getByRole('combobox', { name: 'Star rating' });
    await fireEvent.focus(rating);
    await fireEvent.keyDown(rating, { key: 'ArrowDown' });
    const names = optionNames(rating);
    expect(names).toEqual([
      'Any rating',
      'Not rated',
      'Rejected',
      'Exactly 0 stars',
      'Exactly 1 star',
      'Exactly 2 stars',
      'Exactly 3 stars',
      'Exactly 4 stars',
      'Exactly 5 stars',
      '1 star or more',
      '2 stars or more',
      '3 stars or more',
      '4 stars or more',
      '5 stars or more',
    ]);
  });

  it('names visibility choices instead of showing the stored value', async () => {
    const { panel } = setup();
    const visibility = within(panel).getByRole('combobox', { name: 'Visibility' });
    await fireEvent.focus(visibility);
    await fireEvent.keyDown(visibility, { key: 'ArrowDown' });
    const names = optionNames(visibility);
    expect(names).toEqual(expect.arrayContaining(['Archived', 'Timeline', 'Hidden', 'Locked']));
    expect(names).not.toContain('archive');
  });
});
