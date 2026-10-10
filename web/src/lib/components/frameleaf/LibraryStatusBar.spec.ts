import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import LibraryStatusBar from './LibraryStatusBar.svelte';

beforeEach(() => {
  addMessages('dev', en);
});

describe('LibraryStatusBar', () => {
  it('is not drawn when it has nothing to add to the page', () => {
    // The count is in the results toolbar, the selection is on the selection bar, the view was kept.
    render(LibraryStatusBar, { count: 1284, total: 1284, saved: true });

    expect(screen.queryByTestId('library-status-bar')).not.toBeInTheDocument();
  });

  it('never repeats the selected count or says the view was saved', () => {
    render(LibraryStatusBar, { count: 12, total: 1284, saved: true });
    const bar = screen.getByTestId('library-status-bar');

    expect(bar).not.toHaveTextContent('selected');
    expect(bar).not.toHaveTextContent('Saved on this device');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says so plainly when this device could not keep the view', () => {
    render(LibraryStatusBar, { count: 1, saved: false });

    expect(screen.getByRole('status')).toHaveTextContent('Your view isn’t saved · keep this tab open');
  });

  it('leaves the count out until it is known', () => {
    render(LibraryStatusBar, { count: null, total: 1284, saved: false });

    expect(screen.getByTestId('library-status-bar')).not.toHaveTextContent('items');
  });

  it('steps aside, out of reach, while the selection bar is open', () => {
    render(LibraryStatusBar, { count: 4, total: 9, saved: true, hidden: true });
    const bar = screen.getByTestId('library-status-bar');

    expect(bar).toHaveClass('is-hidden');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(bar).toHaveAttribute('inert');
  });

  it('says how many of the whole scope the filter leaves, and what is selected outside it', () => {
    render(LibraryStatusBar, { count: 12, total: 1284, outside: 2, saved: true });
    const bar = screen.getByTestId('library-status-bar');

    expect(bar).toHaveTextContent('12 of 1,284 items');
    expect(bar).toHaveTextContent('2 selected items aren’t shown here');
  });

  it('says only what is selected elsewhere when nothing is filtered out', () => {
    render(LibraryStatusBar, { count: 40, total: 40, outside: 1, saved: true });
    const bar = screen.getByTestId('library-status-bar');

    expect(bar).toHaveTextContent('1 selected item isn’t shown here');
    expect(bar).not.toHaveTextContent('40');
  });
});
