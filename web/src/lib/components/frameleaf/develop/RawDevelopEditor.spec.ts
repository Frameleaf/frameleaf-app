import { sdkMock } from '$lib/__mocks__/sdk.mock';
import type { AssetDevelopRevisionResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import RawDevelopEditor from './RawDevelopEditor.svelte';

const previews = vi.hoisted(() => ({ calls: [] as Array<{ id: string; recipe: Record<string, unknown>; size: number }> }));
vi.mock('$lib/frameleaf/develop-api', () => ({
  PREVIEW_DEBOUNCE_MS: 0,
  developFileUrl: () => '/file',
  followDevelop: () => () => {},
  requestDevelopPreview: (id: string, recipe: Record<string, unknown>, size: number) => {
    previews.calls.push({ id, recipe, size });
    return Promise.resolve({ url: `blob:${previews.calls.length}`, revoke: () => {} });
  },
}));

const photos = [
  { id: 'a', fileName: 'IMG_0001.CR3', rating: 4, canRate: true, edited: false },
  { id: 'b', fileName: 'IMG_0002.NEF', rating: null, canRate: true, edited: false },
];
const lastPreview = () => previews.calls.at(-1);

describe('RawDevelopEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previews.calls = [];
    sdkMock.getAssetDevelop.mockImplementation(({ id }) =>
      Promise.resolve({ assetId: id, currentRevisionId: null, revisions: [] }),
    );
    sdkMock.getDevelopPresets.mockResolvedValue([]);
    sdkMock.getAssetInfo.mockResolvedValue({
      exifInfo: { make: 'Canon', model: 'Canon EOS R5', exifImageWidth: 8192, exifImageHeight: 5464 },
    } as never);
  });

  const renderShoot = (props: Record<string, unknown> = {}) =>
    render(RawDevelopEditor, {
      photos,
      initialId: 'a',
      shoot: { id: 'shoot-1', name: 'Mara & Sam' },
      onBack: vi.fn(),
      onProof: vi.fn(),
      rate: vi.fn().mockResolvedValue(undefined),
      ...props,
    });

  it("opens a shoot's RAW photos with the Darkroom, the filmstrip and the inspector", async () => {
    renderShoot();
    expect(screen.getByRole('button', { name: /frameleaf_develop_back_to_shoot/ })).toBeInTheDocument();
    expect(screen.getByText('Mara & Sam')).toBeInTheDocument();
    expect(await screen.findByText('Canon EOS R5')).toBeInTheDocument();
    expect(screen.getByText('8192 × 5464')).toBeInTheDocument();
    const filmstrip = screen.getByLabelText('frameleaf_develop_filmstrip');
    expect(within(filmstrip).getAllByRole('button', { name: /frameleaf_develop_open_photo/ })).toHaveLength(2);
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    await waitFor(() => expect(screen.getByText('frameleaf_develop_status_saved')).toBeInTheDocument());
    await waitFor(() => expect(lastPreview()).toMatchObject({ id: 'a', size: 1280 }));
  });

  it('develops each change on the server and marks it unsaved', async () => {
    renderShoot();
    await waitFor(() => expect(screen.getByText('frameleaf_develop_status_saved')).toBeInTheDocument());
    const exposure = screen.getByRole('slider', { name: /frameleaf_editor_param_exposure/ });
    await fireEvent.input(exposure, { target: { value: '1.5' } });
    expect(screen.getByText('frameleaf_develop_status_unsaved')).toBeInTheDocument();
    await waitFor(() => expect(lastPreview()?.recipe).toMatchObject({ exposureEV: 1.5 }));
  });

  it('saves a named version that the server renders', async () => {
    sdkMock.saveAssetDevelop.mockResolvedValue({
      id: 'rev-1',
      revision: 1,
      status: 'queued',
      progress: 0,
      recipe: {},
      isCurrent: false,
    } as unknown as AssetDevelopRevisionResponseDto);
    renderShoot();
    await waitFor(() => expect(screen.getByText('frameleaf_develop_status_saved')).toBeInTheDocument());
    await fireEvent.input(screen.getByRole('slider', { name: /frameleaf_editor_param_exposure/ }), {
      target: { value: '0.5' },
    });
    await fireEvent.click(screen.getAllByRole('button', { name: /frameleaf_editor_save_version/ })[0]);
    const name = await screen.findByRole('textbox', { name: 'frameleaf_raw_version_name' });
    await fireEvent.input(name, { target: { value: 'Golden hour' } });
    await fireEvent.submit(name.closest('form')!);
    await waitFor(() =>
      expect(sdkMock.saveAssetDevelop).toHaveBeenCalledWith({
        id: 'a',
        assetDevelopSaveDto: expect.objectContaining({
          label: 'Golden hour',
          render: true,
          recipe: expect.objectContaining({ version: 2, exposureEV: 0.5 }),
        }),
      }),
    );
  });

  it('asks before leaving with unsaved changes, and can discard them', async () => {
    const onBack = vi.fn();
    renderShoot({ onBack });
    await waitFor(() => expect(screen.getByText('frameleaf_develop_status_saved')).toBeInTheDocument());
    await fireEvent.input(screen.getByRole('slider', { name: /frameleaf_editor_param_exposure/ }), {
      target: { value: '1' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /frameleaf_develop_back_to_shoot/ }));
    expect(onBack).not.toHaveBeenCalled();
    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_develop_leave_discard' }));
    expect(onBack).toHaveBeenCalled();
    expect(sdkMock.saveAssetDevelop).not.toHaveBeenCalled();
  });

  it('draws masks on the whole sensor image', async () => {
    renderShoot();
    await waitFor(() => expect(screen.getByText('frameleaf_develop_status_saved')).toBeInTheDocument());
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_develop_tab_masks' }));
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_develop_mask_radial' }));
    expect(screen.getByRole('button', { name: 'frameleaf_develop_mask_name_radial', pressed: true })).toBeInTheDocument();
    await waitFor(() =>
      expect(lastPreview()?.recipe).toMatchObject({
        sensorCanvas: true,
        masks: [expect.objectContaining({ kind: 'radial', coordinates: 'sensor-active' })],
      }),
    );
  });

  it('rates a photo through the shoot', async () => {
    const rate = vi.fn().mockResolvedValue(undefined);
    renderShoot({ rate });
    await fireEvent.click(screen.getAllByRole('button', { name: 'frameleaf_develop_rate_stars' })[1]);
    expect(rate).toHaveBeenCalledWith('a', 2);
  });

  it('works on one photo from the viewer, and Escape closes it', async () => {
    const onBack = vi.fn();
    render(RawDevelopEditor, { photos: [photos[0]], initialId: 'a', onBack, onLegacy: vi.fn() });
    expect(screen.getByRole('button', { name: /close/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('frameleaf_develop_filmstrip')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'frameleaf_raw_quick_edits' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('frameleaf_develop_status_saved')).toBeInTheDocument());
    await fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onBack).toHaveBeenCalled();
  });
});
