import { AssetVisibility, type AssetResponseDto } from '@immich/sdk';
import {
  canSendCopies,
  isSendable,
  prepareCopies,
  SEND_COPY_LIMIT,
  sendCopies,
  type SendCopyDeps,
} from '$lib/frameleaf/send-copy';

const asset = (id: string, overrides: Partial<AssetResponseDto> = {}) =>
  ({
    id,
    originalFileName: `${id}.jpg`,
    originalMimeType: 'image/jpeg',
    visibility: AssetVisibility.Timeline,
    isTrashed: false,
    ...overrides,
  }) as AssetResponseDto;

const deps = (overrides: Partial<SendCopyDeps> = {}, assets: Record<string, AssetResponseDto> = {}): SendCopyDeps => ({
  getInfo: vi.fn((id: string) => Promise.resolve(assets[id] ?? asset(id))),
  getOriginal: vi.fn(() => Promise.resolve(new Blob(['original'], { type: 'image/jpeg' }))),
  share: vi.fn(() => Promise.resolve()),
  canShare: vi.fn(() => true),
  ...overrides,
});

const namedError = (name: string) => new DOMException(name, name);

describe('canSendCopies', () => {
  it('needs a share sheet that takes files', () => {
    expect(canSendCopies(undefined)).toBe(false);
    expect(canSendCopies({ share: vi.fn() })).toBe(false);
    expect(canSendCopies({ share: vi.fn(), canShare: () => false })).toBe(false);
    expect(canSendCopies({ share: vi.fn(), canShare: () => true })).toBe(true);
  });

  it('asks about files, not a link', () => {
    const canShare = vi.fn(() => true);
    canSendCopies({ share: vi.fn(), canShare });
    const [data] = canShare.mock.calls[0] as unknown as [ShareData];
    expect(data.files).toHaveLength(1);
    expect(data.url).toBeUndefined();
  });

  it('treats a throwing probe as no support', () => {
    expect(
      canSendCopies({
        share: vi.fn(),
        canShare: () => {
          throw new TypeError('no');
        },
      }),
    ).toBe(false);
  });
});

describe('isSendable', () => {
  it('never sends a Locked or trashed item', () => {
    expect(isSendable(asset('a'))).toBe(true);
    expect(isSendable(asset('a', { visibility: AssetVisibility.Locked }))).toBe(false);
    expect(isSendable(asset('a', { isTrashed: true }))).toBe(false);
  });
});

describe('prepareCopies', () => {
  it('names each file after its original and leaves Locked items out before downloading them', async () => {
    const locked = asset('b', { visibility: AssetVisibility.Locked });
    const dependencies = deps({}, { b: locked });
    const prepared = await prepareCopies(['a', 'b', 'a'], dependencies);
    expect(prepared.files.map((file) => file.name)).toEqual(['a.jpg']);
    expect(prepared.files[0].type).toBe('image/jpeg');
    expect(prepared.skipped).toBe(1);
    expect(dependencies.getOriginal).toHaveBeenCalledTimes(1);
    expect(dependencies.getOriginal).toHaveBeenCalledWith('a');
  });

  it('counts an item the server refuses as failed, not sent', async () => {
    const prepared = await prepareCopies(
      ['a', 'b'],
      deps({
        getOriginal: vi.fn((id: string) =>
          id === 'b' ? Promise.reject(new Error('403')) : Promise.resolve(new Blob()),
        ),
      }),
    );
    expect(prepared.files).toHaveLength(1);
    expect(prepared.failed).toBe(1);
  });
});

describe('sendCopies', () => {
  it('hands the original files to the share sheet', async () => {
    const dependencies = deps();
    const result = await sendCopies(['a'], dependencies);
    expect(result.outcome).toBe('sent');
    expect(dependencies.share).toHaveBeenCalledWith({ files: [expect.any(File)], title: 'a.jpg' });
  });

  it('reports a closed share sheet as cancelled', async () => {
    const result = await sendCopies(['a'], deps({ share: vi.fn(() => Promise.reject(namedError('AbortError'))) }));
    expect(result.outcome).toBe('cancelled');
  });

  it('offers a retry from a new click when the download outlasted the original one', async () => {
    const share = vi.fn().mockRejectedValueOnce(namedError('NotAllowedError')).mockResolvedValueOnce(undefined);
    const dependencies = deps({ share });
    const result = await sendCopies(['a'], dependencies);
    expect(result.outcome).toBe('needs-gesture');
    expect((await result.retry!()).outcome).toBe('sent');
    // The retry reuses the prepared files instead of downloading again.
    expect(dependencies.getOriginal).toHaveBeenCalledTimes(1);
  });

  it('says so when the browser cannot share these particular files', async () => {
    const dependencies = deps({ canShare: () => false });
    expect((await sendCopies(['a'], dependencies)).outcome).toBe('unsupported');
    expect(dependencies.share).not.toHaveBeenCalled();
  });

  it('sends nothing when every item is Locked', async () => {
    const dependencies = deps({}, { a: asset('a', { visibility: AssetVisibility.Locked }) });
    const result = await sendCopies(['a'], dependencies);
    expect(result).toMatchObject({ outcome: 'nothing', skipped: 1 });
    expect(dependencies.share).not.toHaveBeenCalled();
  });

  it('refuses more than the limit before downloading anything', async () => {
    const dependencies = deps();
    const ids = Array.from({ length: SEND_COPY_LIMIT + 1 }, (_, index) => `id-${index}`);
    expect((await sendCopies(ids, dependencies)).outcome).toBe('too-many');
    expect(dependencies.getInfo).not.toHaveBeenCalled();
  });
});
