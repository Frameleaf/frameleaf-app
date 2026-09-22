import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sharedLinkFactory } from '$lib/../test-data/factories/shared-link-factory';
import { handleCreateSharedLink, handleUpdateSharedLink } from '$lib/services/shared-link.service';
import { SharedLinkType } from '@immich/sdk';
import en from '../../../../../i18n/en.json';
import SharedLinkForm from './SharedLinkForm.svelte';

vi.mock('$lib/services/shared-link.service', () => ({
  asUrl: () => 'https://frameleaf.local/s/test',
  handleCreateSharedLink: vi.fn().mockResolvedValue(true),
  handleUpdateSharedLink: vi.fn().mockResolvedValue(true),
}));

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('SharedLinkForm', () => {
  it('creates a link over the real endpoint and never leaves the password in the component afterwards', async () => {
    render(SharedLinkForm, {
      open: true,
      target: { type: SharedLinkType.Album, albumId: 'album-1', name: 'Summer trip' },
    });

    await fireEvent.input(screen.getByLabelText(en.password), { target: { value: 'hunter2' } });
    await fireEvent.input(screen.getByLabelText(en.description), { target: { value: 'For the family' } });
    await fireEvent.click(screen.getByRole('button', { name: en.create_link }));

    expect(handleCreateSharedLink).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SharedLinkType.Album,
        albumId: 'album-1',
        description: 'For the family',
        password: 'hunter2',
      }),
    );

    // The password never appears anywhere in the rendered form after submission.
    expect(screen.queryByDisplayValue('hunter2')).toBeNull();
    expect((screen.getByLabelText(en.password) as HTMLInputElement).value).toBe('');
  });

  it('removes an existing password only when the checkbox is used, and preserves it otherwise', async () => {
    const link = sharedLinkFactory.build({
      type: SharedLinkType.Individual,
      assets: [],
      password: 'set',
      slug: 'family',
    });

    render(SharedLinkForm, { open: true, link });

    await fireEvent.click(screen.getByRole('button', { name: en.save }));
    expect(handleUpdateSharedLink).toHaveBeenCalledWith(
      link,
      expect.objectContaining({ password: undefined }),
    );

    vi.clearAllMocks();
    await fireEvent.click(screen.getByLabelText(en.frameleaf_sharing.remove_password));
    await fireEvent.click(screen.getByRole('button', { name: en.save }));
    expect(handleUpdateSharedLink).toHaveBeenCalledWith(link, expect.objectContaining({ password: null }));
  });

  it('computes a future expiry from a preset', async () => {
    const before = Date.now();
    render(SharedLinkForm, {
      open: true,
      target: { type: SharedLinkType.Individual, assetIds: ['a1'], name: '1 item' },
    });

    await fireEvent.change(screen.getByLabelText(en.expire_after), { target: { value: '1d' } });
    await fireEvent.click(screen.getByRole('button', { name: en.create_link }));

    const dto = vi.mocked(handleCreateSharedLink).mock.calls[0][0];
    expect(dto.expiresAt).toBeTruthy();
    expect(Date.parse(dto.expiresAt as string)).toBeGreaterThan(before);
  });
});
