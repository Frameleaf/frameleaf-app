import { render, screen } from '@testing-library/svelte';
import MockBackupArea from '../../../../test-data/components/MockBackupArea.svelte';
import Lazy from './Lazy.svelte';

describe('a settings page fetched when it opens (FL-1799)', () => {
  it('shows the loading placeholder, then the page with what it was given', async () => {
    let arrive!: () => void;
    const load = () =>
      new Promise<{ default: typeof MockBackupArea }>((resolve) => {
        arrive = () => resolve({ default: MockBackupArea });
      });
    render(Lazy, { props: { load, props: { page: 'restore' } } });
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByTestId('backup-area')).toBeNull();

    arrive();
    expect(await screen.findByTestId('backup-area')).toHaveTextContent('restore');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reloads the page to try again when the code cannot be fetched (a release the tab predates)', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...location, reload });
    try {
      const load = vi.fn<() => Promise<{ default: typeof MockBackupArea }>>().mockRejectedValue(new Error('gone'));
      render(Lazy, { props: { load, props: { page: 'overview' } } });
      (await screen.findByRole('button')).click();
      expect(reload).toHaveBeenCalledOnce();
      expect(load).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
