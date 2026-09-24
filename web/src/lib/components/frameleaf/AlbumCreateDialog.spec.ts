import { AlbumKind, type AlbumResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AlbumCreateDialog from './AlbumCreateDialog.svelte';

describe('AlbumCreateDialog smart album', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getAllPeople.mockResolvedValue({ people: [], total: 0, hidden: 0 } as never);
    sdkMock.getAllTags.mockResolvedValue([
      { id: 'tag-lake', value: 'lake', name: 'lake', createdAt: '', updatedAt: '' },
    ]);
    sdkMock.getClassificationSettings.mockResolvedValue({
      visualCategories: true,
      visualSearchAvailable: true,
      defaultAction: 'review' as never,
      inlineLimit: 500,
    });
    sdkMock.previewClassificationRule.mockResolvedValue({
      exact: true,
      sampled: 1,
      matched: 1,
      items: [],
      visualSearchAvailable: true,
    });
  });

  const setup = () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    const onCreateSmart = vi.fn().mockResolvedValue(true);
    render(AlbumCreateDialog, {
      kind: AlbumKind.Album,
      collections: [],
      open: true,
      smart: true,
      onCreate,
      onCreateSmart,
    });
    return { onCreate, onCreateSmart };
  };

  it('does not create an archiving smart album until the person consents', async () => {
    const { onCreate, onCreateSmart } = setup();
    await fireEvent.input(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Receipts' } });
    const lake = await screen.findByRole('checkbox', { name: 'lake' });
    await fireEvent.click(lake);
    await fireEvent.click(screen.getByRole('switch', { name: /Archive matches/ }));

    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(screen.getByText('Confirm that matches may be archived, or turn archiving off.')).toBeInTheDocument(),
    );
    expect(onCreateSmart).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('checkbox', { name: /archived automatically/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreateSmart).toHaveBeenCalledTimes(1));
    expect(onCreateSmart.mock.calls[0][0]).toMatchObject({
      albumName: 'Receipts',
      tagIds: ['tag-lake'],
      archive: true,
      archiveConsent: true,
    });
    expect(onCreate).not.toHaveBeenCalled();
    expect(sdkMock.createAlbum).not.toHaveBeenCalled();
  });

  it('creates a plain smart album without any archiving', async () => {
    const { onCreateSmart } = setup();
    await fireEvent.input(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Lake days' } });
    await fireEvent.click(await screen.findByRole('checkbox', { name: 'lake' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreateSmart).toHaveBeenCalledTimes(1));
    expect(onCreateSmart.mock.calls[0][0]).toMatchObject({ archive: false });
    expect(onCreateSmart.mock.calls[0][0]).not.toHaveProperty('archiveConsent');
  });
});

describe('AlbumCreateDialog editing (AL-2)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  const collection = { id: 'family', albumName: 'Family', kind: AlbumKind.Collection } as AlbumResponseDto;
  const album = {
    id: 'rockies',
    albumName: 'Rockies',
    description: 'Hiking',
    icon: 'mdiImageAlbum',
    kind: AlbumKind.Album,
    parentId: null,
  } as unknown as AlbumResponseDto;

  it('prefills the saved details and saves them with the collection when the owner may move it', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(AlbumCreateDialog, {
      kind: AlbumKind.Album,
      album,
      collections: [collection],
      canMove: true,
      open: true,
      onCreate: vi.fn(),
      onSave,
    });

    expect(screen.getByRole('heading', { name: 'Edit album' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Rockies');
    expect(screen.queryByRole('switch', { name: /Smart album/ })).toBeNull();
    await fireEvent.change(screen.getByRole('combobox', { name: 'In collection' }), { target: { value: 'family' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        albumName: 'Rockies',
        description: 'Hiking',
        icon: 'mdiImageAlbum',
        parentId: 'family',
      }),
    );
  });

  it('never sends a collection for a member who may not move the album', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(AlbumCreateDialog, {
      kind: AlbumKind.Album,
      album,
      collections: [collection],
      open: true,
      onCreate: vi.fn(),
      onSave,
    });

    expect(screen.queryByRole('combobox', { name: 'In collection' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('parentId');
  });
});
