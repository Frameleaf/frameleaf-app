import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import EmptyRow from './EmptyRow.svelte';
import GridSkeleton from './GridSkeleton.svelte';
import ListSkeleton from './ListSkeleton.svelte';
import StatusLine from './StatusLine.svelte';

// FL-1810 (prototype `src/StatesSheet.jsx`): one piece each for empty, loading, saved and failed.
describe('shared state pieces (FL-1810)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  it('EmptyRow shows one line and at most one action', async () => {
    const onClick = vi.fn();
    render(EmptyRow, { title: 'No notes yet', message: 'Only you see them.', action: { label: 'Add note', onClick } });
    expect(screen.getByRole('status')).toHaveTextContent('No notes yet');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('EmptyRow without an action has no button', () => {
    render(EmptyRow, { title: 'No notes yet' });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('the placeholders are busy, labelled, and draw the rows and tiles asked for', () => {
    render(ListSkeleton, { rows: 4 });
    const list = screen.getByTestId('frameleaf-list-skeleton');
    expect(list).toHaveAttribute('aria-busy', 'true');
    expect(list).toHaveAccessibleName('Loading');
    expect(list.querySelectorAll('li')).toHaveLength(4);

    render(GridSkeleton, { tiles: 6 });
    const grid = screen.getByTestId('frameleaf-grid-skeleton');
    expect(grid).toHaveAttribute('aria-busy', 'true');
    expect(grid.querySelectorAll('.fl-skeleton')).toHaveLength(6);
  });

  it('StatusLine says Saving…, Saved, and alerts when not saved', async () => {
    const { rerender } = render(StatusLine, {});
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    await rerender({ state: 'saving' });
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');
    await rerender({ state: 'saved' });
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    await rerender({ state: 'failed', message: 'Not saved: the server didn’t answer.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Not saved: the server didn’t answer.');
  });
});
