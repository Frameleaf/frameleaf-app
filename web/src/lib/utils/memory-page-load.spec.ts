import { load } from '../../routes/(user)/memories/[id]/[[photos=photos]]/[[assetId=id]]/+page';
import { authenticate } from './auth';
import { getFormatter } from './i18n';

const memory = vi.hoisted(() => ({
  loading: Promise.resolve(),
  loadMemory: vi.fn(),
  getMemoryWithAsset: vi.fn(),
  memoriesHref: '/memories',
}));
vi.mock('$lib/managers/memory-manager.svelte', () => ({ memoryManager: memory }));
vi.mock('./auth', () => ({ authenticate: vi.fn() }));
vi.mock('./i18n', () => ({ getFormatter: vi.fn() }));

const id = 'f1b25a82-7ada-4890-b81b-a80e3d8f428a';
const open = (assetId?: string, query?: string, memoryId = id) =>
  load({
    url: new URL(`https://example.test/memories/${memoryId}${query ?? ''}`),
    params: { id: memoryId, assetId },
  } as never);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getFormatter).mockResolvedValue(((key: string) => key) as never);
  memory.loadMemory.mockResolvedValue({ id, assets: [{ id: 'first' }, { id: 'second' }, { id: 'third' }] });
});

it.each([
  ['second', '?assetId=third', 'second'],
  ['missing', '?assetId=missing', 'first'],
  ['', '?assetId=', 'first'],
  [undefined, undefined, 'first'],
])('canonicalizes route %s and query %s to member %s', async (routeAsset, query, selected) => {
  await expect(open(routeAsset, query)).rejects.toMatchObject({
    status: 307,
    location: `/memories/${id}?assetId=${selected}`,
  });
});

it.each([undefined, 'missing'])(
  'keeps the canonical query with route %s and returns translated metadata',
  async (route) => {
    await expect(open(route, '?assetId=second')).resolves.toEqual({ meta: { title: 'memory' } });
  },
);

it('preserves unrelated query parameters when selecting the first asset', async () => {
  await expect(open(undefined, '?other=kept')).rejects.toMatchObject({
    status: 307,
    location: `/memories/${id}?other=kept&assetId=first`,
  });
});

it.each([undefined, { id, assets: [] }])('redirects missing or empty memories', async (value) => {
  memory.loadMemory.mockResolvedValueOnce(value);
  await expect(open()).rejects.toMatchObject({ status: 307, location: '/memories' });
});

it('rejects an invalid memory id before loading it', async () => {
  await expect(open(undefined, undefined, 'invalid')).rejects.toMatchObject({ status: 307 });
  expect(memory.loadMemory).not.toHaveBeenCalled();
});

it('propagates authentication failure before reading memories or translations', async () => {
  const failure = new Error('authentication failed');
  vi.mocked(authenticate).mockRejectedValueOnce(failure);
  await expect(open()).rejects.toBe(failure);
  expect(memory.loadMemory).not.toHaveBeenCalled();
  expect(getFormatter).not.toHaveBeenCalled();
});

it('canonicalizes an asset that belongs to another memory before local selection', async () => {
  memory.getMemoryWithAsset.mockReturnValueOnce({ id: 'another' });
  await expect(open('second', '?other=kept')).rejects.toMatchObject({
    status: 307,
    location: '/memories/another/photos/second?assetId=second',
  });
  expect(memory.getMemoryWithAsset).toHaveBeenCalledExactlyOnceWith('second', id);
});
