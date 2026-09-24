import { SharedLinkType, type SharedLinkResponseDto } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import PublicViewerShell from './PublicViewerShell.svelte';

const link = (patch: Partial<SharedLinkResponseDto> = {}): SharedLinkResponseDto => ({
  id: 'link-1',
  key: 'key',
  slug: null,
  type: SharedLinkType.Album,
  userId: 'owner-1',
  assets: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  description: null,
  expiresAt: null,
  password: null,
  allowDownload: true,
  allowUpload: false,
  showMetadata: true,
  owner: { name: 'Riley' },
  ...patch,
});

const children = createRawSnippet(() => ({ render: () => '<p>grid</p>' }));

const setup = (
  sharedLink: SharedLinkResponseDto,
  props: { selecting?: boolean; selectedCount?: number; noSelectBar?: boolean } = {},
) => {
  const handlers = {
    onSelectingChange: vi.fn(),
    onUpload: vi.fn(),
    onDownloadAll: vi.fn(),
    onDownloadSelected: vi.fn(),
    onSelectAll: vi.fn(),
    onClear: vi.fn(),
  };
  render(PublicViewerShell, {
    sharedLink,
    title: 'Weekend trip',
    count: 3,
    selecting: props.selecting ?? false,
    selectedCount: props.selectedCount ?? 0,
    noSelectBar: props.noSelectBar,
    children,
    ...handlers,
  });
  return handlers;
};

beforeEach(() => {
  addMessages('dev', en);
});

describe('PublicViewerShell', () => {
  it('shows the title, owner and count, and the way back to Frameleaf', () => {
    setup(link());
    expect(screen.getByRole('heading', { name: 'Weekend trip' })).toBeInTheDocument();
    expect(screen.getByText(/Shared by Riley · 3 items/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Frameleaf' })).toHaveAttribute('href', '/');
  });

  it('reads the owner from the link itself and shows their initial, not a fetched image', () => {
    setup(link({ owner: { name: 'élodie' } }));
    expect(screen.getByText(/Shared by élodie · 3 items/)).toBeInTheDocument();
    expect(screen.getByText('É')).toBeInTheDocument();
    expect(document.querySelector('.pv-title img')).toBeNull();
  });

  it('leaves "Shared by" out when the link carries no owner', () => {
    setup(link({ owner: undefined }));
    expect(screen.queryByText(/Shared by/)).not.toBeInTheDocument();
    expect(screen.getByText('3 items')).toBeInTheDocument();
  });

  it('offers downloading everything only when the link allows downloads', async () => {
    const handlers = setup(link());
    await fireEvent.click(screen.getByRole('button', { name: 'Download all' }));
    expect(handlers.onDownloadAll).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Add photos' })).not.toBeInTheDocument();
  });

  it('hides the download on a link without downloads and offers uploads when allowed', () => {
    setup(link({ allowDownload: false, allowUpload: true }));
    expect(screen.queryByRole('button', { name: /^Download/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add photos' })).toBeInTheDocument();
  });

  it('turns the download into the selection in Select mode', async () => {
    const handlers = setup(link(), { selecting: true, selectedCount: 2 });
    expect(screen.getByRole('toolbar', { name: 'Selection' })).toHaveTextContent('2 of 3 selected');
    await fireEvent.click(screen.getByRole('button', { name: 'Download selected (2)' }));
    expect(handlers.onDownloadSelected).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(handlers.onSelectingChange).toHaveBeenCalledWith(false);
  });

  it("leaves the select bar to the library's selection bar when the owner prunes their link", () => {
    setup(link(), { selecting: true, selectedCount: 2, noSelectBar: true });
    expect(screen.queryByRole('toolbar', { name: 'Selection' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('keeps an empty selection from downloading', () => {
    setup(link(), { selecting: true, selectedCount: 0 });
    expect(screen.getByRole('button', { name: 'Download selected (0)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
  });
});
