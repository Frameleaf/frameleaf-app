import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import LibraryStatusBar from './LibraryStatusBar.svelte';

beforeEach(() => {
  addMessages('dev', en);
});

describe('LibraryStatusBar', () => {
  it('says how many items the view shows, how many are selected and that the view was kept (LIB-P6)', () => {
    render(LibraryStatusBar, { count: 1284, total: 1284, selected: 0, saved: true });
    const bar = screen.getByTestId('library-status-bar');

    expect(bar).toHaveTextContent('1,284 items');
    expect(bar).not.toHaveTextContent(' of ');
    expect(bar).toHaveTextContent('0 selected');
    expect(screen.getByRole('status')).toHaveTextContent('Saved on this device');
  });

  it('says so plainly when this device could not keep the view', () => {
    render(LibraryStatusBar, { count: 1, saved: false });

    expect(screen.getByRole('status')).toHaveTextContent('Your view isn’t saved · keep this tab open');
  });

  it('leaves the count out until it is known', () => {
    render(LibraryStatusBar, { count: null, total: null, saved: true });

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
    render(LibraryStatusBar, { count: 12, total: 1284, selected: 3, outside: 2, saved: true });
    const bar = screen.getByTestId('library-status-bar');

    expect(bar).toHaveTextContent('12 of 1,284 items');
    expect(bar).toHaveTextContent('3 selected (2 outside these results)');
  });
});
