import { AssetTypeEnum, LibraryAssetItemKind, type AssetFontResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import BoardsTextStyle from '$lib/components/frameleaf/BoardsTextStyle.svelte';

const item = (id: string, originalFileName: string) => ({
  kind: LibraryAssetItemKind.Asset,
  asset: { id, originalFileName, type: AssetTypeEnum.Other },
});

describe('BoardsTextStyle (FL-1359)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.searchLibraryItems.mockResolvedValue({
      items: [item('f1', 'Larch Sans.ttf'), item('f2', 'Marlow.ttc'), item('x', 'notes.bin')],
    } as never);
    sdkMock.getAssetFont.mockResolvedValue({
      axes: [{ tag: 'wght', name: 'Weight', min: 200, default: 400, max: 800 }],
    } as AssetFontResponseDto);
  });

  it('offers the standard font and the fonts in Boards; one a browser cannot draw cannot be chosen', async () => {
    const onChange = vi.fn();
    render(BoardsTextStyle, { style: undefined, onChange });
    const usable = await screen.findByRole<HTMLOptionElement>('option', { name: 'Larch Sans · TTF' });
    expect(usable.disabled).toBe(false);
    expect(screen.getByRole<HTMLOptionElement>('option', { name: 'frameleaf_boards_text_font_blocked' }).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('option', { name: /notes/ })).toBeNull();

    const [font, size] = screen.getAllByRole('combobox');
    await fireEvent.change(font, { target: { value: 'f1' } });
    expect(onChange).toHaveBeenLastCalledWith({ fontAssetId: 'f1' }, false);
    await fireEvent.change(size, { target: { value: 'l' } });
    expect(onChange).toHaveBeenLastCalledWith({ size: 1.4 }, false);
    await fireEvent.click(screen.getByRole('radio', { name: 'frameleaf_magic_colour_white' }));
    expect(onChange).toHaveBeenLastCalledWith({ color: '#ffffff' }, false);
  });

  it('sets a variable font’s weight, one undo step for each drag', async () => {
    const onChange = vi.fn();
    render(BoardsTextStyle, { style: { fontAssetId: 'f1' }, onChange });
    const weight = await screen.findByRole('slider');
    expect(weight).toHaveValue('400');
    // the first change of a drag starts an undo step, the rest of the drag joins it
    await fireEvent.input(weight, { target: { value: '600' } });
    expect(onChange).toHaveBeenLastCalledWith({ fontAssetId: 'f1', variation: { wght: 600 } }, false);
    await fireEvent.input(weight, { target: { value: '700' } });
    expect(onChange).toHaveBeenLastCalledWith({ fontAssetId: 'f1', variation: { wght: 700 } }, true);
    // letting go ends it: the next drag or key press is its own step
    await fireEvent.change(weight, { target: { value: '700' } });
    await fireEvent.input(weight, { target: { value: '710' } });
    expect(onChange).toHaveBeenLastCalledWith({ fontAssetId: 'f1', variation: { wght: 710 } }, false);
  });

  it('says so when the chosen font is no longer in Boards, and going back to the standard font clears the style', async () => {
    const onChange = vi.fn();
    render(BoardsTextStyle, { style: { fontAssetId: 'gone', variation: { wght: 700 } }, onChange });
    expect(await screen.findByText('frameleaf_boards_text_font_missing')).toBeInTheDocument();
    await fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined, false);
  });

  it('lists fonts beyond the first page of results', async () => {
    sdkMock.searchLibraryItems
      .mockResolvedValueOnce({ items: [item('x', 'notes.bin')], nextCursor: 'page-2' } as never)
      .mockResolvedValueOnce({ items: [item('f9', 'Alder Serif.otf')], nextCursor: null } as never);
    render(BoardsTextStyle, { style: undefined, onChange: vi.fn() });
    expect(await screen.findByRole('option', { name: 'Alder Serif · OTF' })).toBeInTheDocument();
    expect(sdkMock.searchLibraryItems).toHaveBeenLastCalledWith({
      libraryItemSearchDto: expect.objectContaining({ cursor: 'page-2' }),
    });
  });
});
