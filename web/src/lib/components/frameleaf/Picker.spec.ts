import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import Picker from '$lib/components/frameleaf/Picker.svelte';
import en from '../../../../../i18n/en.json';

/**
 * FL-83: the Filters panel's single-choice pickers are the prototype's `SearchableSelect`; a search
 * that matches nothing says what the prototype says (SearchableSelect.jsx:218-222).
 */
describe('Picker', () => {
  beforeAll(() => {
    addMessages('dev', en);
    Element.prototype.scrollIntoView ??= () => {};
    vi.stubGlobal('visualViewport', null);
  });
  afterAll(() => vi.unstubAllGlobals());

  it('says "No matching options" when the search matches nothing', async () => {
    render(Picker, {
      label: 'Camera',
      options: [
        { id: 'sony', label: 'Sony', value: 'Sony' },
        { id: 'canon', label: 'Canon', value: 'Canon' },
      ],
    });
    const input = screen.getByRole('combobox', { name: 'Camera' });

    await userEvent.type(input, 'Nikon');

    expect(screen.getByRole('option', { name: 'No matching options' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText(en.no_results)).not.toBeInTheDocument();
  });

  it('lists the matching options while searching', async () => {
    render(Picker, {
      label: 'Camera',
      options: [
        { id: 'sony', label: 'Sony', value: 'Sony' },
        { id: 'canon', label: 'Canon', value: 'Canon' },
      ],
    });

    await userEvent.type(screen.getByRole('combobox', { name: 'Camera' }), 'Can');

    expect(screen.getAllByRole('option').map((option) => option.textContent?.trim())).toEqual(['Canon']);
  });
});
