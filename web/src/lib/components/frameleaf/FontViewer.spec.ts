import { AssetTypeEnum, LibraryScope, type AssetFontResponseDto, type AssetResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import FontViewer from '$lib/components/frameleaf/FontViewer.svelte';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';

vi.mock('$lib/frameleaf/library-access', () => ({ onLibraryAccessChange: () => () => {} }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const facts = (patch: Partial<AssetFontResponseDto> = {}): AssetFontResponseDto => ({
  family: 'Larch Sans',
  style: 'Regular',
  weight: 400,
  italic: false,
  glyphCount: 2548,
  axes: [],
  instances: [],
  features: ['kern', 'liga', 'tnum'],
  scripts: ['latin'],
  license: null,
  licenseUrl: null,
  faces: [],
  browserLoadable: true,
  ready: true,
  ...patch,
});
const face = { family: 'Marlow', style: 'Bold', weight: 700, italic: false, glyphCount: 500 };

describe('FontViewer (FL-1359)', () => {
  const asset = timelineAssetFactory.build({ originalFileName: 'LarchSans.ttf', isImage: false, isVideo: false });

  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getAssetSources.mockResolvedValue([]);
    sdkMock.getAssetInfo.mockResolvedValue({
      id: asset.id,
      ownerId: 'someone-else',
      type: AssetTypeEnum.Other,
      libraryScope: LibraryScope.Design,
      originalFileName: 'LarchSans.ttf',
      originalMimeType: 'font/ttf',
      exifInfo: {},
      people: [],
      tags: [],
    } as unknown as AssetResponseDto);
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add: vi.fn() } });
    vi.stubGlobal(
      'FontFace',
      class {
        load = () => Promise.resolve(this);
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lets you try a font the browser can load: your own words, its axes and features', async () => {
    const weight = { tag: 'wght', name: 'Weight', min: 200, default: 400, max: 800 };
    sdkMock.getAssetFont.mockResolvedValue(
      facts({ axes: [weight], instances: [{ name: 'Bold', coordinates: { wght: 700 } }] }),
    );
    const onClose = vi.fn();
    render(FontViewer, { asset, onClose });

    const sample = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'frameleaf_boards_font_sample_label',
    });
    expect(sample.style.fontFamily).toContain(`fl-font-${asset.id}`);
    expect(sample.style.fontVariationSettings).toBe('"wght" 400');

    await fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(sample.style.fontVariationSettings).toBe('"wght" 700');
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');

    // only the features people switch are offered; ligatures start on
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    await fireEvent.click(switches[1]);
    expect(sample.style.fontFeatureSettings).toBe('"tnum" 1');

    // Details: the font's facts, and no "Show in Photos too" (a font stays in Boards)
    const details = screen.getByTestId('frameleaf-work-inspector');
    expect(await within(details).findByText('Larch Sans', { selector: 'dd' })).toBeInTheDocument();
    expect(within(details).queryByRole('switch')).toBeNull();

    await fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows the specimen picture for a collection, with the reason', async () => {
    sdkMock.getAssetFont.mockResolvedValue(facts({ browserLoadable: false, faces: [face, face] }));
    render(FontViewer, { asset, onClose: vi.fn() });
    expect(await screen.findByText('frameleaf_boards_font_picture_only')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'frameleaf_boards_font_specimen_of' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'frameleaf_boards_font_sample_label' })).toBeNull();
  });

  it('falls back to the picture when the font file cannot be loaded', async () => {
    vi.stubGlobal(
      'FontFace',
      class {
        load = () => Promise.reject(new Error('403'));
      },
    );
    sdkMock.getAssetFont.mockResolvedValue(facts());
    render(FontViewer, { asset: timelineAssetFactory.build({ originalFileName: 'Gone.otf' }), onClose: vi.fn() });
    expect(await screen.findByText('frameleaf_boards_font_picture_only')).toBeInTheDocument();
  });

  it('leaves keys typed in a Details field to that field, and still closes on Escape elsewhere', async () => {
    sdkMock.getAssetFont.mockResolvedValue(facts());
    const onClose = vi.fn();
    render(FontViewer, { asset, onClose });
    await screen.findByRole('textbox', { name: 'frameleaf_boards_font_sample_label' });

    const field = document.createElement('input');
    const onFieldKey = vi.fn();
    field.addEventListener('keydown', onFieldKey);
    screen.getByTestId('frameleaf-work-inspector').append(field);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    field.dispatchEvent(escape);
    expect(onFieldKey).toHaveBeenCalledOnce();
    expect(escape.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    // a picker opened on top of the viewer keeps its keys too, Escape included
    const picker = document.createElement('input');
    const onPickerKey = vi.fn();
    picker.addEventListener('keydown', onPickerKey);
    document.body.append(picker);
    picker.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    picker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onPickerKey).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    picker.remove();

    await fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
