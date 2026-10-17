import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import ViewerOfflineBanner from '$lib/components/frameleaf/ViewerOfflineBanner.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';

/**
 * FL-35 / FL-83: the viewer's offline notice. It names the folder the original was last seen in,
 * and "Relink" is the owner's "Show in folder", where a library path is repaired.
 */

const navigation = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => navigation);
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: {} } }));

const owner = userAdminFactory.build({ id: 'owner' });
const withFolders = (enabled: boolean) => {
  const preferences = preferencesFactory.build();
  authManager.setPreferences({ ...preferences, folders: { ...preferences.folders, enabled } });
};

describe('ViewerOfflineBanner', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    navigation.goto.mockReset();
    authManager.setUser(owner);
    withFolders(true);
  });
  afterEach(() => authManager.reset());

  it('names the folder and relinks there', async () => {
    render(ViewerOfflineBanner, {
      asset: assetFactory.build({ ownerId: 'owner', originalPath: '/photos/2024/trip/IMG_1.jpg' }),
    });
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(en.frameleaf_viewer_offline_title);
    expect(banner).toHaveTextContent('/photos/2024/trip');

    await userEvent.click(screen.getByRole('button', { name: en.frameleaf_viewer_relink }));
    expect(navigation.goto).toHaveBeenCalledWith('/folders?path=%2Fphotos%2F2024%2Ftrip');
  });

  it('describes the problem when no folder was recorded, without a relink', () => {
    render(ViewerOfflineBanner, { asset: assetFactory.build({ ownerId: 'owner', originalPath: 'IMG_1.jpg' }) });
    expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_viewer_offline_description);
    expect(screen.queryByRole('button', { name: en.frameleaf_viewer_relink })).not.toBeInTheDocument();
  });

  it('offers no relink to someone who does not own the item', () => {
    render(ViewerOfflineBanner, {
      asset: assetFactory.build({ ownerId: 'someone-else', originalPath: '/photos/IMG_1.jpg' }),
    });
    expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_viewer_offline_title);
    expect(screen.queryByRole('button', { name: en.frameleaf_viewer_relink })).not.toBeInTheDocument();
  });

  it('offers no relink when folders are switched off', () => {
    withFolders(false);
    render(ViewerOfflineBanner, { asset: assetFactory.build({ ownerId: 'owner', originalPath: '/photos/IMG_1.jpg' }) });
    expect(screen.queryByRole('button', { name: en.frameleaf_viewer_relink })).not.toBeInTheDocument();
  });
});
