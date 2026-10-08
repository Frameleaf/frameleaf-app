import { loadPhotos, loadWorkspace, ratePhoto, saveWorkspace, type Workspace } from './api';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@frameleaf/sdk', () => ({
  defaults: { fetch: transport.fetch, headers: { 'x-test-header': 'configured' } },
  getBaseUrl: () => '/custom-api',
}));

beforeEach(() => {
  transport.fetch.mockReset();
});
it('reuses configured transport and removes hydrated fields from CAS writes', async () => {
  const stored: Workspace = {
    revision: 'revision',
    shoots: [
      {
        id: 'shoot',
        albumId: 'album',
        name: 'Portrait',
        client: 'Jamie',
        date: '2026-09-30',
        type: 'Portrait',
        stage: 'Imported',
        unavailable: false,
        coverAssetId: null,
        assetCount: 0,
      },
    ],
  };
  transport.fetch.mockResolvedValue(Response.json(stored, { headers: { 'Content-Type': 'application/json' } }));
  await expect(saveWorkspace(stored)).resolves.toEqual(stored);
  const [url, options] = transport.fetch.mock.calls[0];
  expect(url).toBe('/custom-api/photography/shoots');
  expect(options.headers.get('x-test-header')).toBe('configured');
  expect(options.credentials).toBe('include');
  expect(JSON.parse(options.body)).toEqual({
    expectedRevision: 'revision',
    shoots: [
      {
        id: 'shoot',
        albumId: 'album',
        name: 'Portrait',
        client: 'Jamie',
        date: '2026-09-30',
        type: 'Portrait',
        stage: 'Imported',
      },
    ],
  });
});
it('preserves cursor encoding and sends culling to the shoot-scoped endpoint', async () => {
  transport.fetch
    .mockResolvedValueOnce(Response.json({ photos: [], nextCursor: null }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  await loadPhotos('shoot', 'a+/b=');
  expect(transport.fetch.mock.calls[0][0]).toBe('/custom-api/photography/shoots/shoot/photos?cursor=a%2B%2Fb%3D');
  await ratePhoto('shoot', 'asset', -1);
  expect(JSON.parse(transport.fetch.mock.calls[1][1].body)).toEqual({ assetId: 'asset', rating: -1 });
});
it('reports conflicts and failures instead of returning empty or optimistic success', async () => {
  transport.fetch
    .mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockRejectedValueOnce(new Error('offline'));
  await expect(saveWorkspace({ revision: null, shoots: [] })).rejects.toMatchObject({
    code: 'settings_changed',
    status: 409,
  });
  await expect(loadWorkspace()).rejects.toThrow('offline');
});

it('uses private branding routes and preserves the distinction between omitted and cleared logos', async () => {
  const { loadBrand, saveBrand, loadLogos, logoThumbnailUrl } = await import('./api');
  const brand = {
    name: 'Studio',
    tagline: '',
    email: '',
    phone: '',
    logoInitials: 'S',
    color: '#577059',
    background: '#f5f3ed',
    textColor: '#263329',
    font: 'editorial' as const,
    watermarkColor: '#ffffff',
    watermarkOpacity: 45,
    watermarkPosition: 'bottom-right' as const,
    watermarkSize: 6,
  };
  transport.fetch.mockImplementation(async () => Response.json({ revision: 'new', brand, logoUnavailable: true }));
  await loadBrand();
  expect(transport.fetch.mock.calls[0][0]).toBe('/custom-api/photography/shoots/branding');
  await saveBrand('loaded', brand);
  expect(JSON.parse(transport.fetch.mock.calls[1][1].body)).toEqual({ expectedRevision: 'loaded', brand });
  await saveBrand('loaded', { ...brand, logoAssetId: null });
  expect(JSON.parse(transport.fetch.mock.calls[2][1].body).brand.logoAssetId).toBeNull();
  await loadLogos('a+/b=');
  expect(transport.fetch.mock.calls[3][0]).toBe('/custom-api/photography/shoots/branding/logos?cursor=a%2B%2Fb%3D');
  expect(logoThumbnailUrl('logo')).toBe('/custom-api/photography/shoots/branding/logos/logo/thumbnail');
});
