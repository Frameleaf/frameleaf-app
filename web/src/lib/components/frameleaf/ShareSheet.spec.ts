import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import ShareSheet from './ShareSheet.svelte';

beforeEach(() => {
  addMessages('dev', en);
});

describe('ShareSheet', () => {
  it('offers the public link only: partner sharing exposes a whole library, not the selected items', () => {
    render(ShareSheet, { open: true, assetIds: ['a1'] });
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: /share with/i })).toBeNull();
    expect(screen.getByRole('button', { name: en.frameleaf_sharing.create_public_link })).toBeInTheDocument();
  });

  it('opens the real shared-link form for the selection', async () => {
    render(ShareSheet, { open: true, assetIds: ['a1', 'a2'] });
    expect(screen.queryByRole('dialog', { name: en.frameleaf_sharing.create_shared_link_title })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_sharing.create_public_link }));

    expect(
      await screen.findByRole('dialog', { name: en.frameleaf_sharing.create_shared_link_title }),
    ).toBeInTheDocument();
  });

  it('reports once when the sheet closes, so the viewer can open it through the modal manager (AL-33)', async () => {
    const onClosed = vi.fn();
    render(ShareSheet, { open: true, assetIds: ['a1'], onClosed });
    expect(onClosed).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: en.cancel }));
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
