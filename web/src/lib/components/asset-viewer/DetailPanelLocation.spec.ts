import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import DetailPanelLocation from '$lib/components/asset-viewer/DetailPanelLocation.svelte';
import { landmarkHref } from '$lib/frameleaf/landmarks';
import { assetFactory } from '@test-data/factories/asset-factory';
import en from '../../../../../i18n/en.json';

/** FL-354: the information panel names the landmark an item was taken at, under its location. */

const at = { latitude: 33.8121, longitude: -117.919, city: 'Anaheim', state: 'California', country: 'United States' };
const park = { id: 'Q181185', name: 'Disneyland Park', kind: 'theme_park', latitude: 33.81, longitude: -117.92 };
const resort = { id: 'Q206859', name: 'Disneyland Resort', kind: 'resort', latitude: 33.81, longitude: -117.92 };

describe('DetailPanelLocation', () => {
  beforeAll(() => addMessages('dev', en));

  it('names the first landmark and links to everything taken there', () => {
    const asset = assetFactory.build({ exifInfo: at as never, landmarks: [park, resort] });
    render(DetailPanelLocation, { asset, isOwner: true });

    const link = screen.getByTestId('frameleaf-info-landmark');
    expect(link).toHaveTextContent('At Disneyland Park');
    expect(link).toHaveTextContent(en.frameleaf_landmark_kind_theme_park);
    expect(link).toHaveAttribute('href', landmarkHref(park.id));
    expect(screen.queryByText('At Disneyland Resort')).not.toBeInTheDocument();
  });

  it('shows no landmark line for an item taken at none', () => {
    render(DetailPanelLocation, { asset: assetFactory.build({ exifInfo: at as never }), isOwner: true });

    expect(screen.getByTestId('frameleaf-info-location')).toHaveTextContent('Anaheim');
    expect(screen.queryByTestId('frameleaf-info-landmark')).not.toBeInTheDocument();
  });

  it.each([
    ['temporal', 'Inferred at Disneyland Park'],
    ['visual', 'Likely showing Disneyland Park'],
  ] as const)('labels %s evidence on a photo without GPS', (inference, label) => {
    const asset = assetFactory.build({
      exifInfo: { latitude: null, longitude: null } as never,
      landmarks: [{ ...park, inference }],
    });
    render(DetailPanelLocation, { asset, isOwner: true });
    expect(screen.getByTestId('frameleaf-info-landmark')).toHaveTextContent(label);
    expect(screen.queryByRole('link', { name: 'Open in OpenStreetMap' })).not.toBeInTheDocument();
  });

  it('keeps the recorded place first and labels a recognised distant landmark alongside it', () => {
    const asset = assetFactory.build({ exifInfo: at as never, landmarks: [park, { ...resort, inference: 'visual' }] });
    render(DetailPanelLocation, { asset, isOwner: true });
    expect(screen.getByText('At Disneyland Park')).toBeInTheDocument();
    expect(screen.getByText('Likely showing Disneyland Resort')).toBeInTheDocument();
  });
});
