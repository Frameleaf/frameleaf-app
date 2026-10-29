import { AssetAnnotationKind, type AssetAnnotationItem } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import BoardsViewer from '$lib/components/frameleaf/BoardsViewer.svelte';
import { BoardsAnnotationsState } from '$lib/frameleaf/boards-annotations-store.svelte';

const items: AssetAnnotationItem[] = [
  { id: 'a1', kind: AssetAnnotationKind.Rect, geometry: { x: 0.05, y: 0.27, width: 0.45, height: 0.2 }, note: 'Cut' },
  { id: 'a2', kind: AssetAnnotationKind.Arrow, geometry: { x: 0.36, y: 0.66, endX: 0.2, endY: 0.56 } },
  { id: 'a3', kind: AssetAnnotationKind.Text, geometry: { x: 0.44, y: 0.93 }, text: 'v2', note: 'Friday' },
];

const setup = async (startMode: 'view' | 'annotate' = 'annotate', show = true) => {
  sdkMock.getAssetAnnotations.mockResolvedValue({
    version: 1,
    sourceRevision: 'rev',
    sourceChanged: false,
    canEdit: true,
    items,
    updatedAt: null,
  } as never);
  sdkMock.replaceAssetAnnotations.mockResolvedValue({ sourceRevision: 'rev' } as never);
  const annotations = new BoardsAnnotationsState('asset-1');
  await annotations.load();
  const onShowChange = vi.fn();
  const onClose = vi.fn();
  const view = render(BoardsViewer, {
    name: 'homepage-hero-v2.png',
    src: '/preview.jpg',
    annotations,
    startMode,
    show,
    onShowChange,
    onClose,
  });
  return { annotations, onShowChange, onClose, view };
};
const shapes = () => [...document.querySelectorAll<SVGGElement>('[data-annotation]')];

describe('BoardsViewer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the annotate toolbar and lists every annotation in the drawing order', async () => {
    await setup();
    const toolbar = screen.getByRole('toolbar', { name: 'frameleaf_boards_annotate' });
    expect(
      within(toolbar)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      'frameleaf_boards_annotate_choose (V)',
      'frameleaf_boards_annotate_rectangle (R)',
      'frameleaf_boards_annotate_arrow (A)',
      'frameleaf_boards_annotate_text (T)',
      'undo',
      'frameleaf_boards_annotation_delete',
    ]);
    expect(screen.getByRole('button', { name: 'done' })).toBeInTheDocument();
    // every annotation on the picture is focusable, with the same label as its list entry
    expect(shapes().map((shape) => shape.getAttribute('tabindex'))).toEqual(['0', '0', '0']);
    expect(shapes()[0]).toHaveAttribute('aria-label', 'frameleaf_boards_annotation_label');
    expect(screen.getByRole('group', { name: 'frameleaf_boards_annotations_on' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('adds a rectangle from the keyboard, then undoes it and saves each change', async () => {
    const { annotations } = await setup();
    await fireEvent.keyDown(document.body, { key: 'r' });
    expect(screen.getByRole('button', { name: 'frameleaf_boards_annotate_rectangle (R)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(annotations.items).toHaveLength(4);
    expect(annotations.items[3]).toMatchObject({
      kind: 'rect',
      geometry: { x: 0.4, y: 0.4, width: 0.2, height: 0.16 },
    });
    // the new one is chosen and its note is ready to write
    expect(annotations.selected).toBe(annotations.items[3].id);
    await vi.advanceTimersByTimeAsync(700);
    expect(sdkMock.replaceAssetAnnotations).toHaveBeenLastCalledWith({
      id: 'asset-1',
      assetAnnotationsUpdateDto: {
        version: 1,
        sourceRevision: 'rev',
        items: expect.arrayContaining([expect.objectContaining({ kind: 'rect' })]),
      },
    });
    expect(sdkMock.replaceAssetAnnotations.mock.lastCall?.[0].assetAnnotationsUpdateDto.items).toHaveLength(4);

    await fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(annotations.items).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(700);
    expect(sdkMock.replaceAssetAnnotations.mock.lastCall?.[0].assetAnnotationsUpdateDto.items).toHaveLength(3);
    // saving annotations never edits the picture
    expect(sdkMock.updateAsset).not.toHaveBeenCalled();
    expect(sdkMock.editAsset).not.toHaveBeenCalled();
  });

  it('lets Enter press a focused control instead of adding an annotation', async () => {
    const { annotations } = await setup();
    await fireEvent.keyDown(document.body, { key: 'r' });
    const done = screen.getByRole('button', { name: 'done' });
    done.focus();
    // not cancelled, so the browser presses the button as usual
    expect(await fireEvent.keyDown(done, { key: 'Enter' })).toBe(true);
    expect(annotations.items).toHaveLength(3);
    await fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(annotations.items).toHaveLength(4);
  });

  it('moves, resizes and removes the focused annotation with the keyboard', async () => {
    const { annotations } = await setup();
    const first = shapes()[0];
    first.focus();
    await fireEvent.focus(first);
    expect(annotations.selected).toBe('a1');
    await fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(annotations.items[0].geometry.x).toBeCloseTo(0.06);
    await fireEvent.keyDown(first, { key: 'ArrowDown', shiftKey: true });
    expect(annotations.items[0].geometry.y).toBeCloseTo(0.32);
    await fireEvent.keyDown(first, { key: 'ArrowRight', altKey: true });
    expect(annotations.items[0].geometry.width).toBeCloseTo(0.46);
    await fireEvent.keyDown(first, { key: 'Delete' });
    expect(annotations.items.map(({ id }) => id)).toEqual(['a2', 'a3']);
    // the next one is chosen, so Delete can go on through the list
    expect(annotations.selected).toBe('a2');
  });

  it('writes a note from the side list', async () => {
    const { annotations } = await setup();
    const list = screen.getByRole('list', { name: 'frameleaf_boards_annotations' });
    await fireEvent.click(within(list).getAllByRole('button', { name: 'frameleaf_boards_annotation_label' })[1]);
    const note = screen.getByRole('textbox', { name: 'frameleaf_boards_note' });
    await fireEvent.input(note, { target: { value: 'Bigger on phones' } });
    expect(annotations.items[1].note).toBe('Bigger on phones');
  });

  it('hides annotations with H, says how many, and steps back with Esc', async () => {
    const { onShowChange, onClose } = await setup('view', false);
    expect(screen.getByRole('status')).toHaveTextContent('frameleaf_boards_annotations_hidden');
    expect(shapes()).toHaveLength(0);
    await fireEvent.keyDown(document.body, { key: 'h' });
    expect(onShowChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /frameleaf_boards_annotate$/ }));
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    await fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    await fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('reads the annotations again when the picture changed, says so and starts undo afresh', async () => {
    const { annotations } = await setup();
    sdkMock.replaceAssetAnnotations.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
    sdkMock.getAssetAnnotations.mockResolvedValue({
      version: 1,
      sourceRevision: 'rev-2',
      sourceChanged: false,
      canEdit: true,
      items: items.slice(0, 1),
      updatedAt: null,
    } as never);
    await fireEvent.keyDown(document.body, { key: 'r' });
    await fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'undo' })).toBeEnabled();
    await vi.advanceTimersByTimeAsync(700);

    await vi.waitFor(() => expect(annotations.items.map(({ id }) => id)).toEqual(['a1']));
    expect(await screen.findByText('frameleaf_boards_annotations_reloaded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'undo' })).toBeDisabled();
  });

  it('keeps keys from reaching the workspace behind it', async () => {
    await setup('view');
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    await fireEvent.keyDown(document.body, { key: 'Delete' });
    document.removeEventListener('keydown', behind);
    expect(behind).not.toHaveBeenCalled();
  });
});
