import { loadPhotos, loadWorkspace, ratePhoto, saveWorkspace, type Workspace } from './api';
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@immich/sdk', () => ({
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
  transport.fetch.mockResolvedValue(
    new Response(JSON.stringify(stored), { headers: { 'Content-Type': 'application/json' } }),
  );
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
    .mockResolvedValueOnce(new Response(JSON.stringify({ photos: [], nextCursor: null })))
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
  await expect(saveWorkspace({ revision: null, shoots: [] })).rejects.toThrow('Reload before saving');
  await expect(loadWorkspace()).rejects.toThrow('offline');
});
