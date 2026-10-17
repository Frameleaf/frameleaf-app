import {
  AssetJobName,
  Colorspace,
  RawSupportSource,
  RawSupportStatus,
  type RawSupportItemDto,
  type RawSupportResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import RawSupport from './RawSupport.svelte';

const item = (assetId: string, value: Partial<RawSupportItemDto> = {}): RawSupportItemDto => ({
  assetId,
  fileName: `${assetId}.CR3`,
  extension: 'cr3',
  make: 'Canon',
  model: 'EOS R5',
  width: 8192,
  height: 5464,
  status: RawSupportStatus.Ready,
  source: RawSupportSource.Sensor,
  hasFullsize: true,
  renderedAt: '2026-10-01T10:00:00.000Z',
  pairedFileName: null,
  ...value,
});

const response = (items: RawSupportItemDto[]): RawSupportResponseDto => ({
  decoder: { available: true, version: 'LibRaw 0.21.3' },
  developer: { available: false, version: null },
  embeddedPreviews: false,
  fullResolution: true,
  colorspace: Colorspace.P3,
  total: items.length,
  counts: { ready: 1, preview: 0, pending: 1, timeout: 0, unsupported: 1, damaged: 0, dependency: 0 },
  formats: [
    { extension: 'cr3', count: 2, ready: 1, attention: 0, tested: [] },
    { extension: 'raf', count: 1, ready: 0, attention: 1, tested: [] },
  ],
  items,
});

describe('RawSupport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('lists the RAW files with their state and shows the first one', async () => {
    sdkMock.getRawSupport.mockResolvedValue(
      response([
        item('DSCF8142', {
          fileName: 'DSCF8142.RAF',
          extension: 'raf',
          make: 'FUJIFILM',
          model: 'X-T5',
          status: RawSupportStatus.Unsupported,
          pairedFileName: 'DSCF8142.JPG',
        }),
        item('IMG_0001', { status: RawSupportStatus.Pending, source: RawSupportSource.None, renderedAt: null }),
        item('IMG_0002'),
      ]),
    );
    render(RawSupport);

    const list = await screen.findByRole('region', { name: 'frameleaf_raw_support_files' });
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    expect(within(list).getByText('frameleaf_raw_support_status_unsupported')).toBeInTheDocument();
    const details = screen.getByRole('region', { name: 'frameleaf_raw_support_file_details' });
    expect(within(details).getByRole('heading', { name: 'DSCF8142.RAF' })).toBeInTheDocument();
    expect(within(details).getByText('DSCF8142.JPG')).toBeInTheDocument();
    expect(within(details).getByText('frameleaf_raw_support_detail_unsupported')).toBeInTheDocument();
    expect(sdkMock.getRawSupport).toHaveBeenCalledWith({ limit: 200 });
  });

  it('makes a missing preview again with the regenerate-thumbnail job and follows it', async () => {
    sdkMock.getRawSupport.mockResolvedValue(
      response([
        item('IMG_0001', { status: RawSupportStatus.Pending, source: RawSupportSource.None, renderedAt: null }),
      ]),
    );
    sdkMock.runAssetJobs.mockResolvedValue(undefined as never);
    render(RawSupport);

    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_raw_support_action_generate' }));

    expect(sdkMock.runAssetJobs).toHaveBeenCalledWith({
      assetJobsDto: { assetIds: ['IMG_0001'], name: AssetJobName.RegenerateThumbnail },
    });
    expect(await screen.findByRole('region', { name: 'frameleaf_raw_support_repair_progress' })).toBeInTheDocument();
    expect(screen.getByText('frameleaf_raw_support_repair_running')).toBeInTheDocument();
  });

  it('offers repair only when a file can be repaired', async () => {
    sdkMock.getRawSupport.mockResolvedValue(response([item('IMG_0002')]));
    render(RawSupport);
    const reprocess = await screen.findByRole('button', { name: 'frameleaf_raw_support_reprocess' });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'IMG_0002.CR3' })).toBeInTheDocument());
    expect(reprocess).toBeDisabled();
  });

  it('shows what this server can show and develop per camera format', async () => {
    sdkMock.getRawSupport.mockResolvedValue(response([item('IMG_0002')]));
    render(RawSupport);
    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_raw_support_tab_formats' }));

    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    // Header row, the prototype's seven families.
    expect(rows).toHaveLength(8);
    expect(within(rows[1]).getByText('CR2 / CR3')).toBeInTheDocument();
    expect(within(rows[1]).getByText('frameleaf_raw_support_viewing_ready')).toBeInTheDocument();
    expect(within(rows[1]).getByText('frameleaf_raw_support_development_missing')).toBeInTheDocument();
  });

  it('says so when the status cannot be loaded, and loads again on retry', async () => {
    sdkMock.getRawSupport.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response([]));
    render(RawSupport);
    expect(await screen.findByText('frameleaf_raw_support_load_failed')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('frameleaf_raw_support_empty_title')).toBeInTheDocument();
  });
});
