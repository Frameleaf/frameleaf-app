import { AssetDevelopRevisionStatus, type AssetDevelopRevisionResponseDto } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { initialNativeRecipe } from '$lib/frameleaf/native-develop';
import { DevelopConflictError, RawDevelopSession } from '$lib/frameleaf/raw-develop-session.svelte';

const followed = vi.hoisted(() => ({ calls: [] as Array<{ id: string; onUpdate: (develop: unknown) => void }> }));
vi.mock('$lib/frameleaf/develop-api', () => ({
  PREVIEW_DEBOUNCE_MS: 0,
  followDevelop: (id: string, onUpdate: (develop: unknown) => void) => {
    followed.calls.push({ id, onUpdate });
    return () => {};
  },
}));

const native = { version: 2, renderer: 'darktable/5.6.1', exposureEV: 1.5 };
const revision = (value: Partial<AssetDevelopRevisionResponseDto> = {}) =>
  ({
    id: 'rev-1',
    assetId: 'a',
    revision: 1,
    label: null,
    status: AssetDevelopRevisionStatus.Rendered,
    progress: 100,
    recipe: native,
    isCurrent: true,
    hasPreview: true,
    createdAt: '2026-10-16T10:00:00.000Z',
    ...value,
  }) as AssetDevelopRevisionResponseDto;
const photos = [
  { id: 'a', fileName: 'A.CR3', rating: null, canRate: true, edited: true },
  { id: 'b', fileName: 'B.CR3', rating: 3, canRate: true, edited: false },
];

describe('RawDevelopSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    followed.calls = [];
    sdkMock.getAssetDevelop.mockImplementation(({ id }) =>
      Promise.resolve(
        id === 'a'
          ? { assetId: 'a', currentRevisionId: 'rev-1', revisions: [revision()] }
          : { assetId: id, currentRevisionId: null, revisions: [] },
      ),
    );
  });

  it('opens a photo on its current native version, unchanged', async () => {
    const session = new RawDevelopSession(photos, 'a');
    await session.open('a');
    expect(session.record('a')).toMatchObject({ status: 'ready', revisionId: 'rev-1', foreign: false });
    expect(session.record('a').recipe.exposureEV).toBe(1.5);
    expect(session.isDirty('a')).toBe(false);
    expect(session.isEdited('a')).toBe(true);
  });

  it('sends only the source version from this photo preview and retains it on a conflict', async () => {
    const session = new RawDevelopSession(photos, 'a');
    await session.open('a');
    await session.open('b');
    session.record('a').sourceVersion = 'd'.repeat(64);
    session.record('b').sourceVersion = 'e'.repeat(64);
    sdkMock.saveAssetDevelop.mockRejectedValueOnce(new Error('source changed'));
    await expect(session.save('a')).rejects.toThrow('source changed');
    expect(sdkMock.saveAssetDevelop).toHaveBeenCalledWith(
      expect.objectContaining({
        assetDevelopSaveDto: expect.objectContaining({ expectedSourceVersion: 'd'.repeat(64) }),
      }),
    );
    expect(session.record('a').sourceVersion).toBe('d'.repeat(64));
    session.dispose();
  });

  it('starts from the original when the library shows a version from another editor', async () => {
    sdkMock.getAssetDevelop.mockResolvedValue({
      assetId: 'a',
      currentRevisionId: 'rev-1',
      revisions: [revision({ recipe: { version: 1, exposure: 1 } as never })],
    });
    const session = new RawDevelopSession(photos, 'a');
    await session.open('a');
    expect(session.record('a')).toMatchObject({ foreign: true, revisionId: undefined });
    expect(session.record('a').recipe).toEqual(initialNativeRecipe());
  });

  it('keeps an undo history, one step per slider drag', async () => {
    const session = new RawDevelopSession(photos, 'b');
    await session.open('b');
    session.patch('b', { exposureEV: 0.2 }, 'exposure');
    session.patch('b', { exposureEV: 0.4 }, 'exposure');
    session.patch('b', { contrast: 1.2 }, 'contrast');
    expect(session.record('b').undo).toHaveLength(2);
    expect(session.isDirty('b')).toBe(true);
    session.undo('b');
    expect(session.record('b').recipe).toMatchObject({ exposureEV: 0.4 });
    expect(session.record('b').recipe.contrast).toBeUndefined();
    session.redo('b');
    expect(session.record('b').recipe.contrast).toBe(1.2);
  });

  it('saves the working recipe as a new rendered version on the one it came from, once per press', async () => {
    let finish: (value: AssetDevelopRevisionResponseDto) => void = () => {};
    sdkMock.saveAssetDevelop.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const session = new RawDevelopSession(photos, 'a');
    await session.open('a');
    session.patch('a', { contrast: 1.3, sensorCanvas: true });
    const first = session.save('a', ' Warm ');
    void session.save('a');
    finish(revision({ id: 'rev-2', revision: 2, status: AssetDevelopRevisionStatus.Queued, isCurrent: false }));
    await first;
    expect(sdkMock.saveAssetDevelop).toHaveBeenCalledTimes(1);
    expect(sdkMock.saveAssetDevelop).toHaveBeenCalledWith({
      id: 'a',
      assetDevelopSaveDto: {
        recipe: { version: 2, renderer: 'darktable/5.6.1', exposureEV: 1.5, contrast: 1.3 },
        sourceRevisionId: 'rev-1',
        expectedCurrentRevisionId: 'rev-1',
        replaceRecipe: true,
        label: 'Warm',
        render: true,
      },
    });
    expect(session.isDirty('a')).toBe(false);
    expect(session.record('a').revisionId).toBe('rev-2');
    expect(followed.calls.at(-1)?.id).toBe('a');
  });

  it('tells the editor when a saved version is shown in the library', async () => {
    const onPublished = vi.fn();
    sdkMock.saveAssetDevelop.mockResolvedValue(
      revision({ id: 'rev-2', status: AssetDevelopRevisionStatus.Queued, isCurrent: false }),
    );
    const session = new RawDevelopSession(photos, 'b', { onPublished });
    await session.open('b');
    session.patch('b', { exposureEV: 1 });
    await session.save('b');
    followed.calls.at(-1)!.onUpdate({
      assetId: 'b',
      currentRevisionId: 'rev-2',
      revisions: [
        revision({ id: 'rev-2', assetId: 'b', status: AssetDevelopRevisionStatus.Rendered, isCurrent: true }),
      ],
    });
    expect(onPublished).toHaveBeenCalledWith('b');
    expect(session.record('b').currentRevisionId).toBe('rev-2');
    // Its own version became current, so the next save builds on it (FL-431).
    expect(session.record('b').baseCurrentRevisionId).toBe('rev-2');
  });

  it('refuses a save when another device changed the current version, keeping the edits (FL-431)', async () => {
    sdkMock.isHttpError.mockImplementation((error) => typeof (error as { status?: unknown }).status === 'number');
    sdkMock.saveAssetDevelop.mockRejectedValueOnce(
      Object.assign(new Error('Conflict'), {
        status: 409,
        data: { code: 'develop_current_revision_changed', currentRevisionId: 'rev-elsewhere' },
      }),
    );
    const session = new RawDevelopSession(photos, 'a');
    await session.open('a');
    session.patch('a', { contrast: 1.3 });
    sdkMock.getAssetDevelop.mockResolvedValue({
      assetId: 'a',
      currentRevisionId: 'rev-elsewhere',
      revisions: [revision({ id: 'rev-elsewhere', revision: 2 }), revision({ isCurrent: false })],
    });

    await expect(session.save('a')).rejects.toBeInstanceOf(DevelopConflictError);
    expect(sdkMock.saveAssetDevelop.mock.calls[0][0].assetDevelopSaveDto).toMatchObject({
      expectedCurrentRevisionId: 'rev-1',
    });
    expect(session.record('a')).toMatchObject({ currentRevisionId: 'rev-elsewhere', revisionId: 'rev-1' });
    expect(session.record('a').recipe.contrast).toBe(1.3);
    expect(session.isDirty('a')).toBe(true);

    sdkMock.saveAssetDevelop.mockResolvedValueOnce(
      revision({ id: 'rev-3', revision: 3, status: AssetDevelopRevisionStatus.Queued, isCurrent: false }),
    );
    await session.save('a');
    expect(sdkMock.saveAssetDevelop.mock.calls[1][0].assetDevelopSaveDto).toMatchObject({
      expectedCurrentRevisionId: 'rev-elsewhere',
    });
  });

  it('applies a look and changes its strength as one step', async () => {
    const session = new RawDevelopSession(photos, 'b');
    await session.open('b');
    session.look('b', 'mono', 100);
    session.look('b', 'mono', 40);
    expect(session.record('b').recipe.saturation).toBe(0.6);
    expect(session.record('b').look).toMatchObject({ id: 'mono', strength: 40 });
    expect(session.record('b').undo).toHaveLength(1);
    session.patch('b', { exposureEV: 1 });
    expect(session.record('b').look).toBeNull();
  });

  it('applies a saved preset over the photo’s framing and own masks', async () => {
    const session = new RawDevelopSession(photos, 'b');
    await session.open('b');
    session.patch('b', { crop: { x: 0, y: 0, w: 0.5, h: 1 }, rotation: 90 });
    session.applyPreset('b', {
      id: 'p',
      name: 'Bright',
      settings: { native: { version: 2, renderer: 'darktable/5.6.1', exposureEV: 0.7 } },
    } as never);
    expect(session.record('b').recipe).toMatchObject({
      exposureEV: 0.7,
      crop: { x: 0, y: 0, w: 0.5, h: 1 },
      rotation: 90,
    });
  });

  it('steps through the filmstrip and keeps the selection', async () => {
    const session = new RawDevelopSession(photos, 'a');
    session.step(1);
    expect(session.activeId).toBe('b');
    session.step(1);
    expect(session.activeId).toBe('a');
    session.toggleSelected('b');
    session.selectAll();
    expect(session.selected).toEqual(['a', 'b']);
    await vi.waitFor(() => expect(session.record('b').status).toBe('ready'));
  });
});
