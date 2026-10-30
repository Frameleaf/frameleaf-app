import { AssetDevelopFileKind, defaults } from '@frameleaf/sdk';
import { developFileUrl, parseHdrHistogram, requestDevelopPreview } from './develop-api';

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { params: {} } }));

it('keeps explicit photo exports on the authorized revision route', () => {
  const url = new URL(
    developFileUrl('asset', 'revision', AssetDevelopFileKind.Master, 'rendered', 'hdr-jpeg'),
    'https://frameleaf.test',
  );
  expect(url.pathname).toBe('/api/assets/asset/develop/revisions/revision/file');
  expect(url.searchParams.get('format')).toBe('hdr-jpeg');
  expect(url.searchParams.get('kind')).toBe('master');
  expect(url.searchParams.get('c')).toBe('rendered');
  expect(new URL(developFileUrl('asset', 'revision'), 'https://frameleaf.test').searchParams.has('format')).toBe(false);
});

it('accepts a bounded linear HDR histogram and refuses corrupt response evidence', () => {
  const value = {
    version: 1,
    bins: 64,
    minStops: -10,
    maxStops: 6,
    referenceWhite: 203,
    peakStops: 3,
    max: 1,
    samples: 1,
    clipped: { shadows: 0, highlights: 0 },
    red: Array.from({ length: 64 }, () => 0),
    green: Array.from({ length: 64 }, () => 0),
    blue: Array.from({ length: 64 }, () => 0),
    luma: Array.from({ length: 64 }, () => 0),
  };
  expect(parseHdrHistogram(JSON.stringify(value))).toEqual(value);
  expect(parseHdrHistogram(JSON.stringify({ ...value, red: [1] }))).toBeUndefined();
  expect(parseHdrHistogram(JSON.stringify({ ...value, clipped: { shadows: 1.1, highlights: 0 } }))).toBeUndefined();
  expect(parseHdrHistogram('{')).toBeUndefined();
});

it('collects HDR evidence through the configured SDK fetch wrapper', async () => {
  const previous = defaults.fetch;
  const configured = vi
    .fn()
    .mockResolvedValue(new Response(new Blob(['hdr']), { headers: { 'Content-Type': 'image/jpeg' } }));
  defaults.fetch = configured;
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:hdr');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  try {
    const result = await requestDevelopPreview('asset', { version: 3 }, 1280, undefined, 'auto');
    expect(configured).toHaveBeenCalledOnce();
    const request = JSON.parse(configured.mock.calls[0][1].body);
    expect(request).toMatchObject({ recipe: { version: 3 }, size: 1280, dynamicRange: 'auto' });
    expect(result?.url).toBe('blob:hdr');
    result?.revoke();
    expect(revoke).toHaveBeenCalledWith('blob:hdr');
  } finally {
    defaults.fetch = previous;
    create.mockRestore();
    revoke.mockRestore();
  }
});

describe('a preview while the server is busy with another render (FL-677)', () => {
  let previous: typeof defaults.fetch;
  beforeEach(() => {
    previous = defaults.fetch;
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  });
  afterEach(() => {
    defaults.fetch = previous;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const busy = () => Response.json({ message: 'Native development is busy; try again shortly' }, { status: 503 });
  const image = () => new Response(new Blob(['jpeg']), { headers: { 'Content-Type': 'image/jpeg' } });

  it('waits and asks again instead of failing', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy()).mockResolvedValueOnce(image());
    defaults.fetch = fetch;
    const pending = requestDevelopPreview('asset', { version: 1 } as never, 1280);
    // Waits 0.5 s, then 1 s, before the third request.
    await vi.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toMatchObject({ url: 'blob:preview' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('stops waiting as soon as a newer preview supersedes it', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(busy()));
    defaults.fetch = fetch;
    const controller = new AbortController();
    const pending = requestDevelopPreview('asset', { version: 1 } as never, 1280, controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(pending).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('bounds a retry that is still rendering when the wait runs out', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(busy())
      .mockImplementation(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
          ),
      );
    defaults.fetch = fetch;
    const pending = requestDevelopPreview('asset', { version: 1 } as never, 1280);
    const assertion = expect(pending).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after a bounded wait and fails at once on other errors', async () => {
    defaults.fetch = vi.fn().mockImplementation(() => Promise.resolve(busy()));
    const pending = requestDevelopPreview('asset', { version: 1 } as never, 1280);
    const assertion = expect(pending).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(125_000);
    await assertion;

    const failed = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    defaults.fetch = failed;
    await expect(requestDevelopPreview('asset', { version: 1 } as never, 1280)).rejects.toMatchObject({
      status: 500,
    });
    expect(failed).toHaveBeenCalledOnce();
  });
});
