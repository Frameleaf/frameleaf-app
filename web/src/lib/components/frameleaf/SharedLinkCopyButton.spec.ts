import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import SharedLinkCopyButton from './SharedLinkCopyButton.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const stubClipboard = (writeText: (value: string) => Promise<void>) =>
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

describe('SharedLinkCopyButton', () => {
  it('confirms a copy that reached the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const onCopied = vi.fn();
    render(SharedLinkCopyButton, { value: 'https://example.test/s/abc', label: 'Copy link', onCopied });

    await fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() => expect(screen.getByTestId('link-copied')).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith('https://example.test/s/abc');
    expect(onCopied).toHaveBeenCalledOnce();
  });

  it('never confirms a copy the browser refused', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    stubClipboard(writeText);
    const onCopied = vi.fn();
    render(SharedLinkCopyButton, { value: 'https://example.test/s/abc', label: 'Copy link', onCopied });

    await fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    await Promise.resolve();

    expect(screen.queryByTestId('link-copied')).not.toBeInTheDocument();
    expect(onCopied).not.toHaveBeenCalled();
  });
});
