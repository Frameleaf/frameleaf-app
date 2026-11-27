import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages, init } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderEntry, FolderListing } from '$lib/frameleaf/folder-readers';
import en from '../../../../../i18n/en.json';
import FolderChooser from './FolderChooser.svelte';

const TREE: Record<string, FolderListing> = {
  '': { choosable: false, folders: [{ id: '/mnt', name: 'mnt' }] },
  '/mnt': { choosable: true, detail: '/mnt', folders: [{ id: '/mnt/photos', name: 'photos', detail: '1,204 photos' }] },
  '/mnt/photos': { choosable: true, detail: '/mnt/photos', folders: [] },
  '/mnt/locked': { choosable: false, folders: [], problem: 'Frameleaf can’t open this folder.' },
};
const read = vi.fn((trail: FolderEntry[]) => Promise.resolve(TREE[trail.at(-1)?.id ?? '']));

const open = (overrides = {}) => {
  const props = { rootName: 'This server', read, onClose: vi.fn(), onChoose: vi.fn(), ...overrides };
  render(FolderChooser, props);
  return props;
};
const button = (name: string | RegExp) => screen.findByRole('button', { name });

describe('FolderChooser', () => {
  beforeAll(async () => {
    addMessages('en', en);
    await init({ fallbackLocale: 'en', initialLocale: 'en' });
  });
  beforeEach(() => {
    read.mockClear();
    HTMLDialogElement.prototype.showModal ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.close ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    });
  });

  it('opens at the top, where nothing can be chosen yet', async () => {
    open();
    expect(screen.getByRole('dialog', { name: en.frameleaf_backup_browse_chooser_title })).toBeInTheDocument();
    await button('mnt');
    expect(screen.getByText(en.frameleaf_takeout_folder_open_to_choose)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.frameleaf_takeout_folder_choose_this })).toBeDisabled();
  });

  it('walks into folders, shows the way back, and hands over the chosen folder', async () => {
    const props = open();
    await fireEvent.click(await button('mnt'));
    await fireEvent.click(await button(/^photos/));
    expect(await screen.findByText(en.frameleaf_takeout_folder_none)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'photos' })).toHaveAttribute('aria-current', 'page');

    // the trail goes back up
    await fireEvent.click(screen.getByRole('button', { name: 'mnt' }));
    await fireEvent.click(await button(/^photos/));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: en.frameleaf_takeout_folder_choose_this })).toBeEnabled(),
    );
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_takeout_folder_choose_this }));

    expect(props.onChoose).toHaveBeenCalledWith(
      [
        { id: '/mnt', name: 'mnt' },
        { id: '/mnt/photos', name: 'photos', detail: '1,204 photos' },
      ],
      TREE['/mnt/photos'],
    );
  });

  it('starts in a given folder and says why one cannot be used', async () => {
    open({ start: [{ id: '/mnt/locked', name: 'locked' }] });
    expect(await screen.findByRole('alert')).toHaveTextContent('Frameleaf can’t open this folder.');
    expect(screen.getByRole('button', { name: en.frameleaf_takeout_folder_choose_this })).toBeDisabled();
  });

  it('offers to try again when the folders cannot be read', async () => {
    read.mockRejectedValueOnce(new Error('offline'));
    open();
    expect(await screen.findByText(en.frameleaf_libraries_browse_failed)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_error_retry }));
    expect(await button('mnt')).toBeInTheDocument();
  });
});
