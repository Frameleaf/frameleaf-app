import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AlbumCleanupMoveDialog from '$lib/components/frameleaf/album-cleanup/AlbumCleanupMoveDialog.svelte';
import type { PlanNode } from '$lib/frameleaf/album-cleanup';

const collection = (id: string, name: string, children: PlanNode[] = []) =>
  ({ id, name, kind: 'collection', albumCount: 1, children }) as unknown as PlanNode;

describe(AlbumCleanupMoveDialog.name, () => {
  const structure = [collection('trips', 'Trips', [collection('y2016', '2016', [collection('disney', 'Disney')])])];
  const node = collection('other', 'Other');

  it('lists the top two levels, and finds a deeper collection by searching', async () => {
    render(AlbumCleanupMoveDialog, { node, structure, open: true, onPick: vi.fn() });
    expect(screen.getByRole('button', { name: /2016/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disney/ })).not.toBeInTheDocument();

    await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'disney' } });

    expect(screen.getByRole('button', { name: /Disney/ })).toBeInTheDocument();
  });
});
