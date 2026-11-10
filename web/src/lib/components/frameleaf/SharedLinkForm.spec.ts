import { SharedLinkType } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { sharedLinkFactory } from '$lib/../test-data/factories/shared-link-factory';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { handleCreateSharedLink, handleUpdateSharedLink } from '$lib/services/shared-link.service';
import en from '../../../../../i18n/en.json';
import SharedLinkForm from './SharedLinkForm.svelte';

vi.mock('$lib/services/shared-link.service', () => ({
  asUrl: () => 'https://frameleaf.local/s/test',
  handleCreateSharedLink: vi.fn(),
  handleUpdateSharedLink: vi.fn().mockResolvedValue(true),
}));

/** Every save hands the service a way to report an address that is already used (AL-26). */
const saveOptions = expect.objectContaining({ onSlugTaken: expect.any(Function) });

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  sdkMock.getAllSharedLinks.mockResolvedValue([]);
  sdkMock.getAssetThumbnailPath.mockImplementation((id: string) => `/assets/${id}/thumbnail`);
  vi.mocked(handleCreateSharedLink).mockResolvedValue(
    sharedLinkFactory.build({ type: SharedLinkType.Album, assets: [], password: null }),
  );
});

describe('SharedLinkForm', () => {
  it('creates a link over the real endpoint and never leaves the password in the component afterwards', async () => {
    // `target` is also a mount option name, so the props are passed explicitly.
    render(SharedLinkForm, {
      props: { open: true, target: { type: SharedLinkType.Album, albumId: 'album-1', name: 'Summer trip' } },
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
      saveOptions,
    );

    // The password never appears anywhere after submission, on the Link ready step either.
    await screen.findByRole('heading', { name: en.frameleaf_sharing.link_ready_title });
    expect(screen.queryByDisplayValue('hunter2')).toBeNull();
  });

  it('removes an existing password only when the checkbox is used, and preserves it otherwise', async () => {
    const link = sharedLinkFactory.build({
      type: SharedLinkType.Individual,
      assets: [],
      password: 'set',
      slug: 'family',
    });

    const first = render(SharedLinkForm, { open: true, link });

    await fireEvent.click(screen.getByRole('button', { name: en.save }));
    expect(handleUpdateSharedLink).toHaveBeenCalledWith(
      link,
      expect.objectContaining({ password: undefined }),
      saveOptions,
    );

    // A successful save closes the form, so the second edit opens it again.
    first.unmount();
    vi.clearAllMocks();
    render(SharedLinkForm, { open: true, link });
    await fireEvent.click(screen.getByLabelText(en.frameleaf_sharing.remove_password));
    await fireEvent.click(screen.getByRole('button', { name: en.save }));
    expect(handleUpdateSharedLink).toHaveBeenCalledWith(link, expect.objectContaining({ password: null }), saveOptions);
  });

  it('computes a future expiry from a preset', async () => {
    const before = Date.now();
    render(SharedLinkForm, {
      props: { open: true, target: { type: SharedLinkType.Individual, assetIds: ['a1'], name: '1 item' } },
    });

    await fireEvent.change(screen.getByLabelText(en.frameleaf_sharing.expires), { target: { value: '1d' } });
    await fireEvent.click(screen.getByRole('button', { name: en.create_link }));

    const dto = vi.mocked(handleCreateSharedLink).mock.calls[0][0];
    expect(dto.expiresAt).toBeTruthy();
    expect(Date.parse(dto.expiresAt as string)).toBeGreaterThan(before);
  });

  it('ties download to metadata: originals carry EXIF and GPS, so hiding metadata turns download off', async () => {
    render(SharedLinkForm, {
      props: { open: true, target: { type: SharedLinkType.Individual, assetIds: ['a1'], name: '1 item' } },
    });

    const download = screen.getByRole('switch', { name: new RegExp(`^${en.frameleaf_sharing.allow_download}`) });
    const metadata = screen.getByRole('switch', { name: new RegExp(`^${en.show_metadata}`) });
    // The design's default hides metadata, so a new link starts without downloads.
    expect(metadata).not.toBeChecked();
    expect(download).not.toBeChecked();
    expect(download).toBeDisabled();
    expect(screen.getByText(en.frameleaf_sharing.download_needs_metadata)).toBeInTheDocument();

    await fireEvent.click(metadata);
    expect(download).toBeEnabled();
    await fireEvent.click(download);
    expect(download).toBeChecked();

    // Turning metadata off again turns download off with it.
    await fireEvent.click(metadata);
    expect(download).not.toBeChecked();
    expect(download).toBeDisabled();

    await fireEvent.click(screen.getByRole('button', { name: en.create_link }));
    expect(handleCreateSharedLink).toHaveBeenCalledWith(
      expect.objectContaining({ showMetadata: false, allowDownload: false }),
      saveOptions,
    );
  });

  it('ends on the Link ready step with the address, instead of a separate QR modal', async () => {
    render(SharedLinkForm, {
      props: { open: true, target: { type: SharedLinkType.Album, albumId: 'album-1', name: 'Summer trip' } },
    });

    await fireEvent.click(screen.getByRole('button', { name: en.create_link }));

    expect(await screen.findByRole('heading', { name: en.frameleaf_sharing.link_ready_title })).toBeInTheDocument();
    expect(screen.getByLabelText(en.frameleaf_sharing.link_address)).toHaveValue('https://frameleaf.local/s/test');
    expect(screen.getByRole('button', { name: en.frameleaf_sharing.qr_code })).toHaveAttribute('aria-pressed', 'false');
  });
  describe('link preview (FL-83 AL-25)', () => {
    it('shows the items as a collage of real thumbnails with live badges, expiry and a viewer summary', async () => {
      render(SharedLinkForm, {
        props: { open: true, target: { type: SharedLinkType.Individual, assetIds: ['a1', 'a2'], name: '2 items' } },
      });

      const preview = screen.getByRole('complementary', { name: en.frameleaf_sharing.link_preview });
      const images = preview.querySelectorAll('img');
      expect(images).toHaveLength(2);
      expect(images[0].getAttribute('src')).toContain('/assets/a1/thumbnail');
      expect(images[1].getAttribute('src')).toContain('/assets/a2/thumbnail');
      expect(within(preview).getByText(en.frameleaf_sharing.preview_individual, { exact: false })).toBeInTheDocument();
      expect(within(preview).getByText(en.frameleaf_sharing.preview_address_pending)).toBeInTheDocument();
      // A selection is known outright: nothing is read for its cover.
      expect(sdkMock.searchAssets).not.toHaveBeenCalled();
      expect(within(preview).queryByText(en.frameleaf_sharing.badge_uploads)).toBeNull();
      expect(
        within(preview).getByText(/People with the link see 2 items\. Camera details and location are hidden\./),
      ).toBeInTheDocument();
      expect(within(preview).getByText(/No password is needed\./)).toBeInTheDocument();
      expect(within(preview).getByText(/The link never expires\./)).toBeInTheDocument();

      await fireEvent.click(screen.getByRole('switch', { name: new RegExp(`^${en.frameleaf_sharing.allow_upload}`) }));
      await fireEvent.input(screen.getByLabelText(en.password), { target: { value: 'hunter2' } });
      await fireEvent.change(screen.getByLabelText(en.frameleaf_sharing.expires), { target: { value: '7d' } });
      await fireEvent.input(screen.getByLabelText(en.description), { target: { value: 'For the family' } });

      expect(within(preview).getByText(en.frameleaf_sharing.badge_uploads)).toBeInTheDocument();
      expect(within(preview).getByText(en.password)).toBeInTheDocument();
      expect(within(preview).getByText(/^Expires in 7 days$/)).toBeInTheDocument();
      expect(within(preview).getByText('For the family')).toBeInTheDocument();
      expect(within(preview).getByText(/A password is required\./)).toBeInTheDocument();
    });

    const sources = (preview: HTMLElement) =>
      [...preview.querySelectorAll('img')].map((image) => image.getAttribute('src'));

    const albumTarget = {
      type: SharedLinkType.Album,
      albumId: 'album-1',
      name: 'Summer trip',
      previewAssetIds: ['cover-1'],
      count: 12,
    };

    it("shows a new album link by the album's cover while its cover items are read, and keeps it if they cannot be", async () => {
      sdkMock.searchAssets.mockRejectedValue(new Error('offline'));
      render(SharedLinkForm, { props: { open: true, target: albumTarget } });

      const preview = screen.getByRole('complementary', { name: en.frameleaf_sharing.link_preview });
      const single = () => {
        expect(sources(preview)).toHaveLength(1);
        expect(sources(preview)[0]).toContain('/assets/cover-1/thumbnail');
        expect(within(preview).getByText('+11')).toBeInTheDocument();
        expect(within(preview).getByText(/Album · Summer trip · 12 items/)).toBeInTheDocument();
      };
      single();
      await vi.waitFor(() => expect(sdkMock.searchAssets).toHaveBeenCalledTimes(1));
      await tick();
      single();
    });

    it('reads the cover items of a new album link once, and shows the four the card will have', async () => {
      sdkMock.searchAssets.mockResolvedValue({
        assets: { items: ['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => ({ id })) },
      } as never);
      render(SharedLinkForm, { props: { open: true, target: albumTarget } });

      const preview = screen.getByRole('complementary', { name: en.frameleaf_sharing.link_preview });
      await vi.waitFor(() => expect(sources(preview)).toHaveLength(4));
      expect(sources(preview).map((source) => source?.match(/assets\/([^/]+)\//)?.[1])).toEqual([
        'cover-1',
        'n1',
        'n2',
        'n3',
      ]);
      expect(within(preview).getByText('+8')).toBeInTheDocument();
      expect(sdkMock.searchAssets).toHaveBeenCalledTimes(1);
      expect(sdkMock.searchAssets).toHaveBeenCalledWith({
        metadataSearchDto: expect.objectContaining({ albumIds: ['album-1'] }),
      });
      expect(sdkMock.getSharedLinkById).not.toHaveBeenCalled();
    });

    it('shows an existing link by the cover and count the link itself carries, and reads nothing for them', () => {
      const link = sharedLinkFactory.build({
        type: SharedLinkType.Album,
        album: { id: 'album-1', albumName: 'Rockies', albumThumbnailAssetId: 'cover-1', assetCount: 15 } as never,
        assets: [],
        assetCount: 15,
        coverAssetIds: ['cover-1', 'n1', 'n2', 'n3'],
        password: null,
        expiresAt: null,
        showMetadata: false,
        allowDownload: false,
        allowUpload: false,
      });
      render(SharedLinkForm, { open: true, link });

      const preview = screen.getByRole('complementary', { name: en.frameleaf_sharing.link_preview });
      expect(sources(preview)).toHaveLength(4);
      expect(sources(preview)[0]).toContain('/assets/cover-1/thumbnail');
      expect(sources(preview)[1]).toContain('/assets/n1/thumbnail');
      expect(within(preview).getByText('+11')).toBeInTheDocument();
      expect(within(preview).getByText(/Album · Rockies · 15 items/)).toBeInTheDocument();
      expect(within(preview).getByText(/People with the link see 15 items\./)).toBeInTheDocument();
      expect(sdkMock.getSharedLinkById).not.toHaveBeenCalled();
      expect(sdkMock.searchAssets).not.toHaveBeenCalled();
    });

    it("counts a selection by the link's own count, not by the few items a response carries", () => {
      // As the list of links returns a selection of six: its first four items, and the real count.
      const link = sharedLinkFactory.build({
        type: SharedLinkType.Individual,
        assets: ['a1', 'a2', 'a3', 'a4'].map((id) => ({ id })) as never,
        assetCount: 6,
        coverAssetIds: ['a1', 'a2', 'a3', 'a4'],
        password: null,
      });
      render(SharedLinkForm, { open: true, link });

      const preview = screen.getByRole('complementary', { name: en.frameleaf_sharing.link_preview });
      expect(sources(preview)).toHaveLength(4);
      expect(within(preview).getByText('+2')).toBeInTheDocument();
      expect(
        within(preview).getByText(new RegExp(`${en.frameleaf_sharing.preview_individual} · 6 items`)),
      ).toBeInTheDocument();
      expect(sdkMock.getSharedLinkById).not.toHaveBeenCalled();
    });
  });

  describe('layout (PR 140 polish)', () => {
    it('is the wide dialog with the three options as switches and the standard footer buttons', async () => {
      render(SharedLinkForm, {
        props: { open: true, target: { type: SharedLinkType.Individual, assetIds: ['a1'], name: '1 item' } },
      });

      const dialog = screen.getByRole('dialog', { name: en.frameleaf_sharing.create_shared_link_title });
      expect(dialog).toHaveClass('wide');
      expect(screen.getAllByRole('switch').map((option) => option.getAttribute('aria-label'))).toEqual([
        en.show_metadata,
        en.frameleaf_sharing.allow_download,
        en.frameleaf_sharing.allow_upload,
      ]);
      const cancel = screen.getByRole('button', { name: en.cancel });
      const create = screen.getByRole('button', { name: en.create_link });
      expect(cancel).toHaveClass('button');
      expect(cancel).not.toHaveClass('primary');
      expect(create).toHaveClass('button', 'primary');
      expect(create.closest('footer')).not.toBeNull();

      // "Link ready" is the ordinary dialog width, with the one primary button.
      await fireEvent.click(create);
      await screen.findByRole('heading', { name: en.frameleaf_sharing.link_ready_title });
      expect(dialog).not.toHaveClass('wide');
      expect(screen.getByRole('button', { name: en.done })).toHaveClass('button', 'primary');
    });
  });

  describe('custom address status (FL-83 AL-26)', () => {
    const renderWithLinks = async () => {
      sdkMock.getAllSharedLinks.mockResolvedValue([
        sharedLinkFactory.build({ id: 'other', slug: 'family', assets: [] }),
      ]);
      render(SharedLinkForm, {
        props: { open: true, target: { type: SharedLinkType.Individual, assetIds: ['a1'], name: '1 item' } },
      });
      await vi.waitFor(() => expect(sdkMock.getAllSharedLinks).toHaveBeenCalled());
      await tick();
      return screen.getByLabelText(en.frameleaf_sharing.custom_address);
    };

    it('says live whether the address is available, taken by one of your links, or not valid', async () => {
      const input = await renderWithLinks();

      await fireEvent.input(input, { target: { value: 'family' } });
      expect(await screen.findByText(en.frameleaf_sharing.slug_taken)).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'true');

      await fireEvent.input(input, { target: { value: 'Summer Trip' } });
      expect(input).toHaveValue('summer-trip');
      expect(screen.getByText(en.frameleaf_sharing.slug_available)).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'false');

      await fireEvent.input(input, { target: { value: 'ab' } });
      expect(screen.getByText(en.frameleaf_sharing.slug_invalid)).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'true');

      await fireEvent.input(input, { target: { value: '' } });
      expect(screen.getByText(en.frameleaf_sharing.slug_hint)).toBeInTheDocument();
    });

    it('does not save an address that is already used', async () => {
      const input = await renderWithLinks();
      await fireEvent.input(input, { target: { value: 'family' } });
      await fireEvent.click(screen.getByRole('button', { name: en.create_link }));

      expect(handleCreateSharedLink).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_sharing.slug_taken);
    });

    it('says the address is already used when the server refuses it on save', async () => {
      vi.mocked(handleCreateSharedLink).mockImplementation((_dto, options) => {
        options?.onSlugTaken?.();
        return Promise.resolve(undefined);
      });
      const input = await renderWithLinks();
      await fireEvent.input(input, { target: { value: 'someone-elses' } });
      await fireEvent.click(screen.getByRole('button', { name: en.create_link }));

      expect(handleCreateSharedLink).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'someone-elses' }),
        expect.objectContaining({ onSlugTaken: expect.any(Function) }),
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_sharing.slug_taken);
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });
  });
});
