import { requestDevelopPreview } from './develop-api';
import { initialNativeRecipe } from './native-develop';
import { DevelopPreviewLoader } from './raw-develop-preview.svelte';

vi.mock('./develop-api', () => ({ PREVIEW_DEBOUNCE_MS: 0, requestDevelopPreview: vi.fn() }));

it('retains each displayed preview version across cached photo switches', async () => {
  const versions = new Map<string, string | undefined>();
  vi.mocked(requestDevelopPreview).mockImplementation(async (id) => ({
    url: `blob:${id}`,
    revoke: vi.fn(),
    sourceVersion: id === 'a' ? 'd'.repeat(64) : 'e'.repeat(64),
  }));
  const loader = new DevelopPreviewLoader((id, version) => versions.set(id, version));
  try {
    loader.request('a', initialNativeRecipe(), 1280);
    await vi.waitFor(() => expect(loader.url).toBe('blob:a'));
    loader.request('b', initialNativeRecipe(), 1280);
    await vi.waitFor(() => expect(loader.url).toBe('blob:b'));
    versions.clear();
    loader.request('a', initialNativeRecipe(), 1280);
    expect(versions.get('a')).toBe('d'.repeat(64));
    expect(requestDevelopPreview).toHaveBeenCalledTimes(2);
  } finally {
    loader.dispose();
  }
});

it('refreshes unchanged settings and invalidates older cached previews for only that photo', async () => {
  vi.mocked(requestDevelopPreview).mockClear();
  let generation = 0;
  const revokes: ReturnType<typeof vi.fn>[] = [];
  vi.mocked(requestDevelopPreview).mockImplementation(async (id) => {
    const revoke = vi.fn();
    revokes.push(revoke);
    return { url: `blob:${id}:${++generation}`, sourceVersion: String(generation).repeat(64), revoke };
  });
  const shown = vi.fn();
  const loader = new DevelopPreviewLoader(shown);
  const recipe = initialNativeRecipe();
  try {
    loader.request('a', recipe, 1280);
    await vi.waitFor(() => expect(loader.url).toBe('blob:a:1'));
    loader.request('a', { ...recipe, exposureEV: 1 }, 1280);
    await vi.waitFor(() => expect(loader.url).toBe('blob:a:2'));
    loader.request('b', recipe, 1280);
    await vi.waitFor(() => expect(loader.url).toBe('blob:b:3'));
    loader.request('a', recipe, 1280);
    expect(loader.url).toBe('blob:a:1');
    loader.request('a', recipe, 1280, true);
    await vi.waitFor(() => expect(loader.url).toBe('blob:a:4'));
    expect(shown).toHaveBeenLastCalledWith('a', '4'.repeat(64), true);
    expect(revokes[0]).toHaveBeenCalledOnce();
    expect(revokes[1]).toHaveBeenCalledOnce();
    loader.request('b', recipe, 1280);
    expect(loader.url).toBe('blob:b:3');
    loader.request('a', { ...recipe, exposureEV: 1 }, 1280);
    await vi.waitFor(() => expect(loader.url).toBe('blob:a:5'));
  } finally {
    loader.dispose();
  }
});

it('keeps the displayed source evidence on refresh failure and permits another explicit retry', async () => {
  const shown = vi.fn();
  vi.mocked(requestDevelopPreview).mockResolvedValue({
    url: 'blob:old',
    sourceVersion: 'd'.repeat(64),
    revoke: vi.fn(),
  });
  const loader = new DevelopPreviewLoader(shown);
  const recipe = initialNativeRecipe();
  try {
    loader.request('a', recipe, 1280);
    await vi.waitFor(() => expect(loader.url).toBe('blob:old'));
    vi.mocked(requestDevelopPreview).mockRejectedValueOnce(new Error('source unavailable'));
    loader.request('a', recipe, 1280, true);
    await vi.waitFor(() => expect(loader.error).toBeInstanceOf(Error));
    expect(loader.url).toBe('blob:old');
    expect(shown).toHaveBeenLastCalledWith('a', 'd'.repeat(64), false);
    vi.mocked(requestDevelopPreview).mockResolvedValueOnce({
      url: 'blob:new',
      sourceVersion: 'e'.repeat(64),
      revoke: vi.fn(),
    });
    loader.request('a', recipe, 1280, true);
    await vi.waitFor(() => expect(loader.url).toBe('blob:new'));
    expect(loader.error).toBeNull();
    expect(shown).toHaveBeenLastCalledWith('a', 'e'.repeat(64), true);
  } finally {
    loader.dispose();
  }
});

it('discards a late refresh after switching photos without publishing its source evidence', async () => {
  const late = { url: 'blob:late', sourceVersion: 'e'.repeat(64), revoke: vi.fn() };
  let resolve!: (value: typeof late) => void;
  const pending = new Promise<typeof late>((complete) => {
    resolve = complete;
  });
  const shown = vi.fn();
  vi.mocked(requestDevelopPreview).mockResolvedValue({
    url: 'blob:old',
    sourceVersion: 'd'.repeat(64),
    revoke: vi.fn(),
  });
  const loader = new DevelopPreviewLoader(shown);
  const recipe = initialNativeRecipe();
  try {
    loader.request('a', recipe, 1280);
    await vi.waitFor(() => expect(loader.url).toBe('blob:old'));
    vi.mocked(requestDevelopPreview).mockClear();
    vi.mocked(requestDevelopPreview).mockReturnValueOnce(pending);
    loader.request('a', recipe, 1280, true);
    await vi.waitFor(() => expect(requestDevelopPreview).toHaveBeenCalledOnce());
    const signal = vi.mocked(requestDevelopPreview).mock.calls[0][3];
    loader.request('b', recipe, 1280);
    await vi.waitFor(() => expect(shown).toHaveBeenLastCalledWith('b', 'd'.repeat(64), false));
    expect(signal?.aborted).toBe(true);
    resolve(late);
    await vi.waitFor(() => expect(late.revoke).toHaveBeenCalledOnce());
    expect(shown).not.toHaveBeenCalledWith('a', 'e'.repeat(64), true);
    expect(loader.busy).toBe(false);
  } finally {
    resolve(late);
    loader.dispose();
  }
});
