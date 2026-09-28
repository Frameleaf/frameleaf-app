import { describe, expect, it, vi } from 'vitest';
import { utilityTool, utilityToolsFor, utilitiesUrl, UTILITY_GROUPS } from '$lib/frameleaf/utilities';
import { loadUtility } from '$lib/frameleaf/utilities-load';
import { redirectUtility } from '$lib/frameleaf/utilities-redirect';
import { Route } from '$lib/route';

const sdk = vi.hoisted(() => ({
  getDuplicateReview: vi.fn(),
  getDuplicateDecisions: vi.fn(),
  getLivePhotoCandidates: vi.fn(),
  listICloudConnections: vi.fn(),
  searchLargeAssets: vi.fn(),
}));
const health = vi.hoisted(() => vi.fn());
vi.mock('@immich/sdk', async (original) => ({ ...(await original<typeof import('@immich/sdk')>()), ...sdk }));
vi.mock('$lib/frameleaf/library-care-load', () => ({ loadLibraryCareHealth: health }));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));

describe('Command Center utilities', () => {
  it('preserves the prototype groups and limits health tools to admins', () => {
    expect(UTILITY_GROUPS).toEqual(['organize', 'repair', 'import', 'automate', 'connect']);
    expect(utilityToolsFor(false).map((tool) => tool.id)).toEqual([
      'duplicates',
      'large-files',
      'geolocation',
      'live-photos',
      'icloud',
      'workflows',
      'downloads',
      'obtainium',
    ]);
    expect(utilityToolsFor(true)).toHaveLength(10);
    expect(utilityTool('preservation')).toBeUndefined();
  });
  it('places utility links in the existing user settings namespace and opens Care as its settings area', () => {
    expect(Route.utilities()).toBe('/user-settings?area=utilities');
    // September 24: Library Care is the Library care settings area, the hub for fixes.
    expect(Route.libraryCare()).toBe('/user-settings?area=care');
    expect(Route.duplicatesUtility({ index: 2 })).toBe('/user-settings?area=utilities&section=duplicates&index=2');
    expect(utilitiesUrl('icloud')).toBe('/user-settings?area=utilities&section=icloud');
  });
  it.each(['missing-media', 'corrupt-media'] as const)(
    'rejects non-admin %s before requesting findings',
    async (tool) => {
      await expect(loadUtility(tool, new URL('https://example.test/user-settings'), false)).rejects.toMatchObject({
        status: 403,
      });
      expect(health).not.toHaveBeenCalled();
    },
  );
  it('loads owner duplicate data without sending another account scope', async () => {
    sdk.getDuplicateReview.mockResolvedValue([]);
    sdk.getDuplicateDecisions.mockResolvedValue([]);
    await loadUtility('duplicates', new URL('https://example.test/user-settings?scope=someone-else'), false);
    expect(sdk.getDuplicateReview).toHaveBeenCalledExactlyOnceWith();
    expect(sdk.getDuplicateDecisions).toHaveBeenCalledExactlyOnceWith();
  });
  it('keeps bookmarked photo ids and review filters in the settings destination', async () => {
    await expect(
      redirectUtility(
        new URL('https://example.test/utilities/duplicates/photos/a?index=2&status=found'),
        'duplicates',
        'a',
      ),
    ).rejects.toMatchObject({
      status: 307,
      location: '/user-settings?area=utilities&section=duplicates&status=found&index=2&assetId=a',
    });
  });
});
