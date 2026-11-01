import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';
import DetailPanelLocation from './DetailPanelLocation.svelte';

const api = vi.hoisted(() => ({ dismiss: vi.fn() }));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  dismissAssetLocationInsight: api.dismiss,
}));

const insight = () => ({
  provider: 'google' as const,
  placeId: 'place-1',
  name: 'Example Café',
  address: '10 Main Street',
  mapsUrl: 'https://www.google.com/maps/search/?api=1&query_place_id=place-1',
  relation: 'near' as 'at' | 'near',
  confidence: 'medium' as const,
  distanceM: 18,
  matchedAt: '2026-10-30T10:00:00Z',
  attributions: [{ displayName: 'Maps contributor', uri: 'https://maps.google.com/contributor/example' }],
});
const located = () => ({
  ...assetFactory.build({ ownerId: 'owner', exifInfo: { latitude: 10, longitude: 20, city: 'Example City' } }),
  locationInsight: insight(),
});

describe('suggested photo location', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.resetAllMocks();
    authManager.setUser(userAdminFactory.build({ id: 'owner' }));
    authManager.setPreferences(preferencesFactory.build());
    api.dismiss.mockResolvedValue(undefined);
  });

  it.each(['at', 'near'] as const)('separates an inferred %s suggestion from geography and landmarks', (relation) => {
    const asset = located();
    asset.locationInsight.relation = relation;
    render(DetailPanelLocation, { asset, isOwner: true });
    const row = screen.getByRole('region', { name: 'Suggested location' });

    expect(screen.getByText('Example City')).toBeInTheDocument();
    expect(row).toHaveTextContent(relation === 'at' ? 'Taken at Example Café' : 'Near Example Café');
    expect(row).toHaveTextContent('10 Main Street');
    expect(within(row).getByTitle(/current map data.*historical visit/i)).toHaveTextContent('Inferred');
    expect(within(row).getByRole('link', { name: 'Open in Google Maps' })).toHaveAttribute(
      'href',
      asset.locationInsight.mapsUrl,
    );
    expect(row).toHaveTextContent('Google Maps');
    expect(within(row).getByRole('link', { name: 'Maps contributor' })).toHaveAttribute(
      'href',
      'https://maps.google.com/contributor/example',
    );
    expect(screen.queryByTestId('frameleaf-info-landmark')).not.toBeInTheDocument();
  });

  it('uses plain text and refuses executable map and attribution links', () => {
    const asset = located();
    asset.locationInsight.name = '<img src=x onerror=alert(1)>';
    asset.locationInsight.mapsUrl = 'javascript:alert(1)';
    asset.locationInsight.attributions = [{ displayName: '<b>Contributor</b>', uri: 'data:text/html,x' }];
    render(DetailPanelLocation, { asset, isOwner: false });
    const row = screen.getByRole('region', { name: 'Suggested location' });

    expect(row).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(row).toHaveTextContent('<b>Contributor</b>');
    expect(row.querySelector('img, b')).toBeNull();
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss suggestion' })).not.toBeInTheDocument();
  });

  it('does not show a suggestion without accessible GPS metadata', () => {
    const asset = { ...located(), exifInfo: undefined };
    render(DetailPanelLocation, { asset, isOwner: false });
    expect(screen.queryByRole('region', { name: 'Suggested location' })).not.toBeInTheDocument();
  });

  it('lets the owner dismiss a suggestion without changing the photo location', async () => {
    const asset = located();
    const onAssetRefresh = vi.fn();
    render(DetailPanelLocation, { asset, isOwner: true, onAssetRefresh });
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss suggestion' }));

    expect(api.dismiss).toHaveBeenCalledExactlyOnceWith({ id: asset.id });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Suggested location' })).not.toBeInTheDocument());
    expect(screen.getByText('Example City')).toBeInTheDocument();
    expect(onAssetRefresh).toHaveBeenCalledExactlyOnceWith({ ...asset, locationInsight: undefined });
  });

  it('keeps the suggestion after a failure and permits an owner retry', async () => {
    api.dismiss.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    render(DetailPanelLocation, { asset: located(), isOwner: true });
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss suggestion' }));
    const alert = await screen.findByRole('alert');
    expect(screen.getByRole('region', { name: 'Suggested location' })).toBeInTheDocument();
    await fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Suggested location' })).not.toBeInTheDocument());
  });

  it.each(['replace', 'return', 'close', 'session'])('ignores an old dismissal after %s', async (change) => {
    const asset = located();
    const pending = deferredPromise<void>();
    api.dismiss.mockReturnValueOnce(pending.promise);
    const onAssetRefresh = vi.fn();
    const view = render(DetailPanelLocation, { asset, isOwner: true, onAssetRefresh });
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss suggestion' }));
    if (change === 'replace' || change === 'return') {
      await view.rerender({ asset: located() });
      if (change === 'return') {
        await view.rerender({ asset });
      }
    } else if (change === 'close') {
      view.unmount();
    } else {
      authManager.reset();
    }
    pending.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAssetRefresh).not.toHaveBeenCalled();
    if (change === 'replace' || change === 'return') {
      expect(screen.getByRole('region', { name: 'Suggested location' })).toBeInTheDocument();
    }
  });
});
