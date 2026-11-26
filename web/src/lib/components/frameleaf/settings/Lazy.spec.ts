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

  it('offers to try again when the code cannot be fetched', async () => {
    const load = vi
      .fn<() => Promise<{ default: typeof MockBackupArea }>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ default: MockBackupArea });
    render(Lazy, { props: { load, props: { page: 'overview' } } });
    (await screen.findByRole('button')).click();
    expect(await screen.findByTestId('backup-area')).toHaveTextContent('overview');
  });
});
