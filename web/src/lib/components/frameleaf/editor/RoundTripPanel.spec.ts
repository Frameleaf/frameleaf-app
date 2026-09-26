import {
  AssetDevelopRevisionKind,
  AssetDevelopRevisionStatus,
  AssetTypeEnum,
  createAssetDevelopExport,
  getAssetDevelopExports,
  importAssetDevelopRendition,
  type DevelopExportResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import RoundTripPanel from './RoundTripPanel.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return {
    ...sdk,
    getAssetDevelopExports: vi.fn(),
    createAssetDevelopExport: vi.fn(),
    importAssetDevelopRendition: vi.fn(),
  };
});

vi.mock('@immich/ui', async () => {
  const actual = await vi.importActual<typeof import('@immich/ui')>('@immich/ui');
  const { default: Icon } = await import('@test-data/components/MockIcon.svelte');
  return { ...actual, Icon, toastManager: { primary: vi.fn(), danger: vi.fn() } };
});

vi.mock('$lib/utils', async () => {
  const actual = await vi.importActual<typeof import('$lib/utils')>('$lib/utils');
  return { ...actual, downloadUrl: vi.fn() };
});

/** Edit in another app (FL-64): export an original, then reconcile the developed file brought back. */
describe('RoundTripPanel', () => {
  const photo = assetFactory.build({ type: AssetTypeEnum.Image, originalFileName: 'IMG_0001.CR3' });
  const exportRow = (overrides: Partial<DevelopExportResponseDto> = {}): DevelopExportResponseDto => ({
    id: '0d9f8b4e-2f7c-4a51-9d1e-6c1e4a2b3c4d',
    assetId: photo.id,
    fileName: photo.originalFileName,
    sourceChecksum: 'ab'.repeat(32),
    isCurrentOriginal: true,
    createdAt: '2026-09-23T09:00:00.000Z',
    ...overrides,
  });
  const developed = () => new File(['developed bytes'], 'IMG_0001.tif', { type: 'image/tiff' });
  const choose = async (file: File) => {
    const input = screen.getByLabelText('frameleaf_editor_roundtrip_file') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await fireEvent.change(input);
  };

  afterEach(() => vi.clearAllMocks());

  it('exports the original, recording its checksum, and downloads it', async () => {
    const { downloadUrl } = await import('$lib/utils');
    vi.mocked(getAssetDevelopExports).mockResolvedValue([]);
    vi.mocked(createAssetDevelopExport).mockResolvedValue(exportRow());
    render(RoundTripPanel, { asset: photo, onImported: vi.fn() });
    expect(await screen.findByText('frameleaf_editor_roundtrip_export_first')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_roundtrip_export' }));
    await waitFor(() => expect(createAssetDevelopExport).toHaveBeenCalledWith({ id: photo.id }));
    expect(downloadUrl).toHaveBeenCalledWith(expect.stringContaining(`/assets/${photo.id}/original`), 'IMG_0001.CR3');
    expect(await screen.findByText('frameleaf_editor_roundtrip_matches')).toBeInTheDocument();
    expect(screen.getByLabelText('frameleaf_editor_roundtrip_file')).toBeInTheDocument();
  });

  it('brings the developed file back against its export with the transfer checksum', async () => {
    vi.mocked(getAssetDevelopExports).mockResolvedValue([exportRow()]);
    const onImported = vi.fn();
    const revision = {
      id: 'imported',
      assetId: photo.id,
      revision: 2,
      kind: AssetDevelopRevisionKind.External,
      status: AssetDevelopRevisionStatus.Queued,
    };
    vi.mocked(importAssetDevelopRendition).mockResolvedValue(revision as never);
    render(RoundTripPanel, { asset: photo, onImported });

    const file = developed();
    await screen.findByLabelText('frameleaf_editor_roundtrip_file');
    await choose(file);
    await fireEvent.input(screen.getByLabelText('frameleaf_editor_roundtrip_software'), {
      target: { value: 'darktable 5' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_roundtrip_import' }));

    await waitFor(() => expect(importAssetDevelopRendition).toHaveBeenCalled());
    const [{ id, assetDevelopImportDto }] = vi.mocked(importAssetDevelopRendition).mock.calls[0];
    expect(id).toBe(photo.id);
    expect(assetDevelopImportDto).toMatchObject({ file, exportId: exportRow().id, software: 'darktable 5' });
    expect(assetDevelopImportDto.renditionChecksum).toMatch(/^[\da-f]{64}$/);
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(revision));
  });

  it('shows the refusal when the file was developed from a different original', async () => {
    vi.mocked(getAssetDevelopExports).mockResolvedValue([exportRow()]);
    vi.mocked(importAssetDevelopRendition).mockRejectedValue(
      new Error('This file was developed from a different original than the photo has now; nothing was changed'),
    );
    const onImported = vi.fn();
    render(RoundTripPanel, { asset: photo, onImported });
    await screen.findByLabelText('frameleaf_editor_roundtrip_file');
    await choose(developed());
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_roundtrip_import' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('frameleaf_editor_roundtrip_import_error');
    expect(onImported).not.toHaveBeenCalled();
  });

  it('offers no return against an export whose original has since changed', async () => {
    vi.mocked(getAssetDevelopExports).mockResolvedValue([exportRow({ isCurrentOriginal: false })]);
    render(RoundTripPanel, { asset: photo, onImported: vi.fn() });
    expect(await screen.findByText('frameleaf_editor_roundtrip_changed')).toBeInTheDocument();
    expect(screen.getByText('frameleaf_editor_roundtrip_export_first')).toBeInTheDocument();
    expect(screen.queryByLabelText('frameleaf_editor_roundtrip_file')).toBeNull();
  });
});
