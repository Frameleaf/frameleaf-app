import { AssetTypeEnum } from '@frameleaf/sdk';
import { render, screen, within } from '@testing-library/svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import ViewerDetailRows from './ViewerDetailRows.svelte';

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), function () {
  return {
    featureFlagsManager: {
      init: vi.fn(),
      loadFeatureFlags: vi.fn(),
      value: { smartSearch: true, trash: true },
    } as never,
  };
});

// FL-1392 (UI review 2026-11-10, B5): Path, Bit depth and Checksum sit under a closed "File details".
describe('ViewerDetailRows', () => {
  const asset = assetFactory.build({
    type: AssetTypeEnum.Image,
    originalFileName: 'PXL_20260816_071400123.jpg',
    originalPath: '/photos/2026/08/PXL_20260816_071400123.jpg',
    checksum: 'c2hhMjU2LWNoZWNrc3Vt',
    exifInfo: { make: 'Google', model: 'Pixel 9', bitsPerSample: 10, colorspace: 'Display P3' },
  });

  it('keeps the file name and the photo’s own details in the main list', () => {
    render(ViewerDetailRows, { asset, isOwner: true });

    const main = screen.getByTestId('frameleaf-info-details').querySelector(':scope > dl') as HTMLElement;
    expect(within(main).getByText('PXL_20260816_071400123.jpg')).toBeInTheDocument();
    expect(within(main).getByText('frameleaf_info_detail_camera')).toBeInTheDocument();
    expect(within(main).getByText('frameleaf_camera_color_space')).toBeInTheDocument();
    for (const label of [
      'frameleaf_info_detail_path',
      'frameleaf_camera_bit_depth',
      'frameleaf_info_detail_checksum',
    ]) {
      expect(within(main).queryByText(label)).not.toBeInTheDocument();
    }
  });

  it('puts Path, Bit depth and Checksum under File details, closed until asked for', () => {
    render(ViewerDetailRows, { asset, isOwner: true });

    const details = screen.getByTestId('frameleaf-info-file-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')).toHaveTextContent('frameleaf_info_file_details');
    for (const label of [
      'frameleaf_info_detail_path',
      'frameleaf_camera_bit_depth',
      'frameleaf_info_detail_checksum',
    ]) {
      expect(within(details).getByText(label)).toBeInTheDocument();
    }
    expect(within(details).queryByText('frameleaf_info_detail_filename')).not.toBeInTheDocument();
  });

  it('draws no File details line when none of its rows apply', () => {
    render(ViewerDetailRows, {
      asset: assetFactory.build({ type: AssetTypeEnum.Image, exifInfo: { make: 'Google', model: 'Pixel 9' } }),
      isOwner: false,
    });

    expect(screen.getByTestId('frameleaf-info-details')).toBeInTheDocument();
    expect(screen.queryByTestId('frameleaf-info-file-details')).not.toBeInTheDocument();
  });
});
