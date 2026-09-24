import { AnalyticsRange, AnalyticsScopeKind } from '@immich/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { SvelteURL } from 'svelte/reactivity';
import AnalyticsArea from '$lib/components/frameleaf/analytics/AnalyticsArea.svelte';
import { analyticsReportFixture } from '$lib/frameleaf/analytics.fixture';
import en from '../../../../../../i18n/en.json';

/** FL-79: the command center's analytics area reads its scope and range from the address. */

const state = vi.hoisted(() => ({ url: new URL('http://localhost/admin/system-settings?area=analytics') }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'me', isAdmin: true } } }));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
const sdk = vi.hoisted(() => ({ getAnalyticsScopes: vi.fn(), getAnalyticsReport: vi.fn() }));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  ...sdk,
}));

const library = 'library:44444444-4444-4444-8444-444444444444';

describe('AnalyticsArea', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    sdk.getAnalyticsScopes.mockResolvedValue({
      scopes: [
        { value: 'all', kind: AnalyticsScopeKind.Host, label: '', userId: null, libraryId: null, removed: false },
        {
          value: library,
          kind: AnalyticsScopeKind.Library,
          label: 'Archive',
          userId: 'u',
          libraryId: 'l',
          removed: false,
        },
      ],
    });
    sdk.getAnalyticsReport.mockResolvedValue(analyticsReportFixture());
  });

  it('reads the scope and range in the address', async () => {
    state.url = new URL(`http://localhost/admin/system-settings?area=analytics&scope=${library}&range=90days`);
    render(AnalyticsArea);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument());
    expect(sdk.getAnalyticsReport).toHaveBeenCalledWith({ scope: library, range: AnalyticsRange.$90Days });
  });

  it('falls back to the whole server for a scope the viewer cannot choose', async () => {
    state.url = new URL('http://localhost/admin/system-settings?area=analytics&scope=account:someone');
    render(AnalyticsArea);
    await waitFor(() => expect(sdk.getAnalyticsReport).toHaveBeenCalled());
    expect(sdk.getAnalyticsReport).toHaveBeenCalledWith({ scope: 'all', range: AnalyticsRange.Year });
  });

  it('withholds the previous report while a changed selection loads and when it fails', async () => {
    state.url = new SvelteURL('http://localhost/admin/system-settings?area=analytics');
    render(AnalyticsArea);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument());
    let rejectNext!: (reason: Error) => void;
    const next = new Promise<never>((_resolve, reject) => {
      rejectNext = reject;
    });
    sdk.getAnalyticsReport.mockReturnValue(next);
    state.url.searchParams.set('scope', library);
    state.url.searchParams.set('range', '90days');
    await waitFor(() =>
      expect(sdk.getAnalyticsReport).toHaveBeenLastCalledWith({
        scope: library,
        range: AnalyticsRange.$90Days,
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent(en.frameleaf_analytics_loading);
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
    rejectNext(new Error('scope unavailable'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not load analytics'));
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
  });

  it('says so when the report cannot be read', async () => {
    sdk.getAnalyticsReport.mockRejectedValue(new Error('boom'));
    state.url = new URL('http://localhost/admin/system-settings?area=analytics');
    render(AnalyticsArea);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not load analytics'));
  });
});
