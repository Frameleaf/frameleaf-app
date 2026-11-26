import { DownloadFormat } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../i18n/en.json';
import DownloadFormatDialog from './DownloadFormatDialog.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { authenticated: true, params: {} } }));

const radio = (name: RegExp) => screen.getByRole('radio', { name });

describe('DownloadFormatDialog (FL-826)', () => {
  beforeAll(() => {
    addMessages('dev', en);
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });
  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getDownloadInfo.mockImplementation(({ downloadInfoDto }) =>
      Promise.resolve({
        archives: [],
        totalSize: { original: 55_200_000, jpeg: 23_700_000, web: 2_700_000 }[downloadInfoDto.format as string] ?? 0,
      }),
    );
  });

  it('starts on the default, sizes each choice for the same items and answers with the one picked', async () => {
    const onClose = vi.fn();
    render(DownloadFormatDialog, {
      count: 3,
      info: { assetIds: ['a', 'b', 'c'] },
      hasVideo: true,
      initial: DownloadFormat.Jpeg,
      onClose,
    });

    expect(screen.getByRole('dialog', { name: 'Download 3 items' })).toBeInTheDocument();
    expect(radio(/High-quality JPEG/)).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(radio(/Web size \(2048 px\)/)).toHaveTextContent(/About 2\.[67] MB/));
    expect(sdkMock.getDownloadInfo).toHaveBeenCalledWith(
      { downloadInfoDto: { assetIds: ['a', 'b', 'c'], format: 'web' } },
      expect.anything(),
    );
    expect(
      screen.getByText(/Videos download as the original file\..*Several items arrive as one zip file\./),
    ).toBeTruthy();
    expect(screen.getByText(/Your default is High-quality JPEG\./)).toBeTruthy();

    // Arrow keys move the choice, as in any group of radio buttons.
    await fireEvent.keyDown(radio(/High-quality JPEG/), { key: 'ArrowDown' });
    expect(radio(/Web size/)).toHaveAttribute('aria-checked', 'true');
    await fireEvent.keyDown(radio(/Web size/), { key: 'ArrowUp' });
    expect(radio(/High-quality JPEG/)).toHaveAttribute('aria-checked', 'true');

    await fireEvent.click(radio(/Web size/));
    await fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(DownloadFormat.Web));
  });

  it('answers with nothing when cancelled, and still offers the choices when sizes cannot be read', async () => {
    sdkMock.getDownloadInfo.mockRejectedValue(new Error('offline'));
    const onClose = vi.fn();
    render(DownloadFormatDialog, { count: 1, info: { assetIds: ['a'] }, initial: DownloadFormat.Original, onClose });

    expect(screen.getByRole('dialog', { name: 'Download' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.queryByText(/About/)).toBeNull();
    expect(screen.queryByText(/zip file/)).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(undefined));
  });
});
