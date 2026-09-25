import { AssetVisibility, type AssetResponseDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import {
  canSendCopies,
  isSendable,
  mapSettled,
  prepareCopies,
  SEND_COPY_LIMIT,
  SEND_COPY_MAX_BYTES,
  sendCopies,
  sendCopiesWithFeedback,
  sendCopyPermitted,
  type SendCopyDeps,
} from '$lib/frameleaf/send-copy';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

const signIn = (id: string) => {
  authManager.setUser(userAdminFactory.build({ id }));
  authManager.setPreferences(preferencesFactory.build());
};

const asset = (id: string, overrides: Partial<AssetResponseDto> = {}) =>
  ({
    id,
    originalFileName: `${id}.jpg`,
    originalMimeType: 'image/jpeg',
    ownerId: 'me',
    visibility: AssetVisibility.Timeline,
    isTrashed: false,
    ...overrides,
  }) as AssetResponseDto;

const deps = (overrides: Partial<SendCopyDeps> = {}, assets: Record<string, AssetResponseDto> = {}): SendCopyDeps => ({
  getInfo: vi.fn((id: string) => Promise.resolve(assets[id] ?? asset(id))),
  getOriginal: vi.fn(() => Promise.resolve(new Blob(['original'], { type: 'image/jpeg' }))),
  getLocationHiddenOwners: vi.fn(() => Promise.resolve(new Set<string>())),
  servesEdited: false,
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
    const { prepared } = await prepareCopies(['a', 'b', 'a'], dependencies);
    expect(prepared.files.map((file) => file.name)).toEqual(['a.jpg']);
    expect(prepared.files[0].type).toBe('image/jpeg');
    expect(prepared.skipped).toBe(1);
    expect(dependencies.getOriginal).toHaveBeenCalledTimes(1);
    expect(dependencies.getOriginal).toHaveBeenCalledWith('a');
  });

  it('counts an item the server refuses as failed, not sent', async () => {
    const { prepared } = await prepareCopies(
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

describe('prepareCopies privacy and memory', () => {
  it('leaves out a partner who keeps locations private before downloading their originals (B2)', async () => {
    const dependencies = deps(
      { getLocationHiddenOwners: vi.fn(() => Promise.resolve(new Set(['partner']))) },
      { b: asset('b', { ownerId: 'partner' }), c: asset('c', { ownerId: 'other-partner' }) },
    );
    const { prepared } = await prepareCopies(['a', 'b', 'c'], dependencies);
    expect(prepared.files.map((file) => file.name)).toEqual(['a.jpg', 'c.jpg']);
    expect(prepared.locationHidden).toBe(1);
    expect(dependencies.getOriginal).not.toHaveBeenCalledWith('b');
  });

  it('does not look the partners up when every item is the viewer’s own', async () => {
    signIn('me');
    const dependencies = deps();
    await prepareCopies(['a'], dependencies);
    expect(dependencies.getLocationHiddenOwners).not.toHaveBeenCalled();
    authManager.reset();
  });

  it('refuses a set larger than the byte cap before downloading anything', async () => {
    const big = asset('a', { exifInfo: { fileSizeInByte: SEND_COPY_MAX_BYTES } });
    const dependencies = deps({}, { a: big, b: asset('b', { exifInfo: { fileSizeInByte: 1 } }) });
    const result = await prepareCopies(['a', 'b'], dependencies);
    expect(result.outcome).toBe('too-large');
    expect(dependencies.getOriginal).not.toHaveBeenCalled();
  });

  it('names a shared link’s copy after the edited file it is served', async () => {
    const edited = asset('a', { originalFileName: 'IMG_1.HEIC', isEdited: true });
    const { prepared } = await prepareCopies(['a'], deps({ servesEdited: true }, { a: edited }));
    expect(prepared.files[0].name).toBe('IMG_1.jpg');
    const { prepared: own } = await prepareCopies(['a'], deps({}, { a: edited }));
    expect(own.files[0].name).toBe('IMG_1.HEIC');
  });

  it('keeps at most a few requests in flight', async () => {
    let running = 0;
    let peak = 0;
    await mapSettled(
      Array.from({ length: 12 }, (_, index) => index),
      4,
      async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running--;
      },
    );
    expect(peak).toBe(4);
  });
});

describe('sendCopyPermitted', () => {
  afterEach(() => authManager.reset());

  it('mirrors the shared-link download gate: downloads and metadata both allowed', () => {
    const link = { allowDownload: true, showMetadata: true, userId: 'owner' };
    expect(sendCopyPermitted(link)).toBe(true);
    expect(sendCopyPermitted({ ...link, showMetadata: false })).toBe(false);
    expect(sendCopyPermitted({ ...link, allowDownload: false })).toBe(false);
  });

  it('lets a signed-in user and a link’s own owner send, and nobody else', () => {
    expect(sendCopyPermitted(undefined)).toBe(false);
    signIn('owner');
    expect(sendCopyPermitted(undefined)).toBe(true);
    expect(sendCopyPermitted({ allowDownload: false, showMetadata: false, userId: 'owner' })).toBe(true);
  });
});

describe('sendCopies', () => {
  it('refuses a session that may not send copies', async () => {
    const dependencies = deps();
    expect((await sendCopies(['a'], dependencies, false)).outcome).toBe('not-permitted');
    expect(dependencies.getInfo).not.toHaveBeenCalled();
  });

  it('hands the original files to the share sheet', async () => {
    const dependencies = deps();
    const result = await sendCopies(['a'], dependencies, true);
    expect(result.outcome).toBe('sent');
    expect(dependencies.share).toHaveBeenCalledWith({ files: [expect.any(File)], title: 'a.jpg' });
  });

  it('reports a closed share sheet as cancelled', async () => {
    const result = await sendCopies(
      ['a'],
      deps({ share: vi.fn(() => Promise.reject(namedError('AbortError'))) }),
      true,
    );
    expect(result.outcome).toBe('cancelled');
  });

  it('offers a retry from a new click when the download outlasted the original one', async () => {
    const share = vi.fn().mockRejectedValueOnce(namedError('NotAllowedError')).mockResolvedValueOnce(undefined);
    const dependencies = deps({ share });
    const result = await sendCopies(['a'], dependencies, true);
    expect(result.outcome).toBe('needs-gesture');
    expect((await result.retry!()).outcome).toBe('sent');
    // The retry reuses the prepared files instead of downloading again.
    expect(dependencies.getOriginal).toHaveBeenCalledTimes(1);
  });

  it('says so when the browser cannot share these particular files', async () => {
    const dependencies = deps({ canShare: () => false });
    expect((await sendCopies(['a'], dependencies, true)).outcome).toBe('unsupported');
    expect(dependencies.share).not.toHaveBeenCalled();
  });

  it('sends nothing when every item is Locked', async () => {
    const dependencies = deps({}, { a: asset('a', { visibility: AssetVisibility.Locked }) });
    const result = await sendCopies(['a'], dependencies, true);
    expect(result).toMatchObject({ outcome: 'nothing', skipped: 1 });
    expect(dependencies.share).not.toHaveBeenCalled();
  });

  it('refuses more than the limit before downloading anything', async () => {
    const dependencies = deps();
    const ids = Array.from({ length: SEND_COPY_LIMIT + 1 }, (_, index) => `id-${index}`);
    expect((await sendCopies(ids, dependencies, true)).outcome).toBe('too-many');
    expect(dependencies.getInfo).not.toHaveBeenCalled();
  });
});

describe('byte cap for items without a recorded size', () => {
  it('counts unknown sizes as they arrive and gives up past the cap', async () => {
    const dependencies = deps({
      maxBytes: 10,
      getOriginal: vi.fn(() => Promise.resolve(new Blob(['0123456789ab'], { type: 'image/jpeg' }))),
    });
    const result = await sendCopies(['a'], dependencies, true);
    expect(result.outcome).toBe('too-large');
    expect(dependencies.share).not.toHaveBeenCalled();
  });

  it('still sends a set that stays under the cap', async () => {
    const result = await sendCopies(['a', 'b'], deps({ maxBytes: 100 }), true);
    expect(result.outcome).toBe('sent');
  });
});

describe('sendCopiesWithFeedback', () => {
  it('reports a failed partner lookup instead of failing silently', async () => {
    const danger = vi.spyOn(toastManager, 'danger').mockImplementation(() => {});
    const dependencies = deps(
      { getLocationHiddenOwners: vi.fn(() => Promise.reject(new Error('offline'))) },
      { a: asset('a', { ownerId: 'partner' }) },
    );
    await expect(sendCopiesWithFeedback(['a'], dependencies, true)).resolves.toBeUndefined();
    expect(danger).toHaveBeenCalledOnce();
    expect(dependencies.share).not.toHaveBeenCalled();
    danger.mockRestore();
  });
});
