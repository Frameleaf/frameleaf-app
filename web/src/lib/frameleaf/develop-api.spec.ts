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
