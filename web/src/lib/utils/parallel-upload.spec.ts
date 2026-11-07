import { AssetMediaStatus } from '@frameleaf/sdk';
import { ApiError, uploadRequest } from '$lib/utils';
import { partPolicy, splitRange, uploadInParts } from '$lib/utils/parallel-upload';

vi.mock('$lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils')>()),
  sleep: () => Promise.resolve(),
  uploadRequest: vi.fn(),
}));
vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  getBaseUrl: () => '/api',
}));

const MiB = 2 ** 20;
const upload = vi.mocked(uploadRequest);
const sha256 = 'ab'.repeat(32);
const result = { id: '00000000-0000-4000-8000-000000000001', status: AssetMediaStatus.Created };

const respond = (status: number, headers: Record<string, string> = {}, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

const stubServer = (optionsHeaders: Record<string, string>) => {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'OPTIONS') {
      return Promise.resolve(respond(204, optionsHeaders));
    }
    if (init?.method === 'POST') {
      return Promise.resolve(respond(201, { Location: '/api/assets/uploads/abc' }));
    }
    if (init?.method === 'DELETE') {
      return Promise.resolve(respond(204));
    }
    return Promise.resolve(respond(200, {}, result));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const bigFile = (size: number) =>
  ({
    size,
    type: 'video/mp4',
    name: 'long.mp4',
    slice: (a: number, b: number) => new Blob([`${a}-${b}`]),
  }) as unknown as File;

describe('parallel upload', () => {
  beforeEach(() => {
    upload.mockReset();
    vi.unstubAllGlobals();
  });

  it('uses large parts on Wi-Fi and small ones on cellular', () => {
    expect(partPolicy(undefined)).toEqual({ partSize: 256 * MiB, parallel: 4 });
    expect(partPolicy({ type: 'cellular' })).toEqual({ partSize: 16 * MiB, parallel: 2 });
    expect(partPolicy({ saveData: true })).toEqual({ partSize: 16 * MiB, parallel: 2 });
  });

  it('splits a range into parts no larger than the part size', () => {
    expect(splitRange({ offset: 10, size: 25 }, 10)).toEqual([
      { offset: 10, size: 10 },
      { offset: 20, size: 10 },
      { offset: 30, size: 5 },
    ]);
  });

  it('falls back on servers without parallel parts', async () => {
    const fetchMock = stubServer({ 'Upload-Limit': 'max-size=99999999999, max-append-size=67108864' });
    const outcome = await uploadInParts({
      file: bigFile(600 * MiB),
      sha256,
      metadata: {},
      signal: new AbortController().signal,
    });
    expect(outcome).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
  });

  it('sends every part once, capped by the server, and returns the result of the completing part', async () => {
    stubServer({ 'Upload-Limit': 'max-size=99999999999, max-append-size=134217728', 'Upload-Parts': 'max-parallel=6' });
    let inFlight = 0;
    let peak = 0;
    upload.mockImplementation(async (options) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      const last = options.headers?.['Upload-Offset'] === String(4 * 128 * MiB);
      return { status: last ? 200 : 204, data: (last ? result : null) as never };
    });
    const outcome = await uploadInParts({
      file: bigFile(600 * MiB),
      sha256,
      metadata: {},
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual(result);
    const offsets = upload.mock.calls.map(([options]) => Number(options.headers?.['Upload-Offset']));
    expect([...offsets].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4].map((index) => index * 128 * MiB));
    expect(peak).toBe(4);
  });

  it('resends a dropped part as smaller pieces and gives up on a conflict', async () => {
    stubServer({ 'Upload-Limit': 'max-size=99999999999, max-append-size=33554432', 'Upload-Parts': 'max-parallel=1' });
    let dropped = false;
    upload.mockImplementation(() => {
      if (!dropped) {
        dropped = true;
        return Promise.reject(new ProgressEvent('error'));
      }
      return Promise.resolve({ status: 204, data: null as never });
    });
    // The final GET :id/result supplies the outcome when no part returned it.
    const outcome = await uploadInParts({
      file: bigFile(32 * MiB),
      sha256,
      metadata: {},
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual(result);
    const sizes = upload.mock.calls.slice(1).map(([options]) => (options.data as Blob).size);
    expect(upload.mock.calls.slice(1).map(([options]) => options.headers?.['Upload-Offset'])).toEqual([
      '0',
      String(16 * MiB),
    ]);
    expect(sizes).toHaveLength(2);

    upload.mockReset();
    upload.mockRejectedValue(new ApiError('Conflict', 409, ''));
    const fetchMock = stubServer({ 'Upload-Limit': 'max-append-size=33554432', 'Upload-Parts': 'max-parallel=2' });
    await expect(
      uploadInParts({ file: bigFile(32 * MiB), sha256, metadata: {}, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
  });
});
