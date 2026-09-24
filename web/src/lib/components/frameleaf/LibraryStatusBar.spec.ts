import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import LibraryStatusBar from './LibraryStatusBar.svelte';

beforeEach(() => {
  addMessages('dev', en);
});

describe('LibraryStatusBar', () => {
  it('says how many items the view shows, how many are selected and that the view is kept', () => {
    render(LibraryStatusBar, { count: 1284, selected: 3, saved: true });
    const bar = screen.getByTestId('library-status-bar');

    expect(bar).toHaveTextContent('1,284 items');
    expect(bar).toHaveTextContent('3 selected');
    expect(screen.getByRole('status')).toHaveTextContent('Saved on this device');
  });

  it('says so plainly when this device could not keep the view', () => {
    render(LibraryStatusBar, { count: 1, selected: 0, saved: false });

    expect(screen.getByRole('status')).toHaveTextContent('Not saved · keep this tab open');
    expect(screen.getByTestId('library-status-bar')).toHaveTextContent('1 item');
  });

  it('leaves the count out until it is known', () => {
    render(LibraryStatusBar, { count: null, selected: 0, saved: true });

    expect(screen.getByTestId('library-status-bar')).not.toHaveTextContent('items');
  });

  it('steps aside, out of reach, while the selection bar is open', () => {
    render(LibraryStatusBar, { count: 4, selected: 2, saved: true, hidden: true });
    const bar = screen.getByTestId('library-status-bar');

    expect(bar).toHaveClass('is-hidden');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(bar).toHaveAttribute('inert');
  });

  it('says how many of the whole scope the filter leaves, and what is selected outside it', () => {
    render(LibraryStatusBar, { count: 12, total: 1284, selected: 3, outside: 2, saved: true });
    const bar = screen.getByTestId('library-status-bar');

    expect(bar).toHaveTextContent('12 of 1,284 items');
    expect(bar).toHaveTextContent('3 selected');
    expect(bar).toHaveTextContent('(2 outside these results)');
  });

  it('keeps it short when nothing is filtered out', () => {
    render(LibraryStatusBar, { count: 40, total: 40, selected: 0, saved: true });

    expect(screen.getByTestId('library-status-bar')).toHaveTextContent('40 items');
    expect(screen.getByTestId('library-status-bar')).not.toHaveTextContent('of');
    expect(screen.getByTestId('library-status-bar')).not.toHaveTextContent('outside');
  });
});
