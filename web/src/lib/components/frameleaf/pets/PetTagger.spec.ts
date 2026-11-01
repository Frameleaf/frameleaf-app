import {
  PetObservationSource,
  PetObservationState,
  PetSpecies,
  type PetObservationResponseDto,
  type PetResponseDto,
} from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import en from '../../../../../../i18n/en.json';
import PetTagger from './PetTagger.svelte';

/** FL-58: marking a pet with a drawn region, a placed region moved by keyboard, or the whole photo. */
describe('PetTagger', () => {
  const biscuit: PetResponseDto = {
    id: 'pet-biscuit',
    name: 'Biscuit',
    species: PetSpecies.Cat,
    birthDate: null,
    featuredAssetId: null,
    isHidden: false,
    isFavorite: false,
    assetCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.createPetObservation.mockImplementation(({ petObservationCreateDto }) =>
      Promise.resolve({
        id: 'observation-1',
        petId: biscuit.id,
        state: PetObservationState.Confirmed,
        source: PetObservationSource.Manual,
        sourceChecksum: 'c3Vt',
        staleAt: null,
        createdAt: '',
        updatedAt: '',
        boundingBoxX1: null,
        boundingBoxY1: null,
        boundingBoxX2: null,
        boundingBoxY2: null,
        imageWidth: null,
        imageHeight: null,
        ...petObservationCreateDto,
      }),
    );
  });

  const setup = async () => {
    const asset = assetFactory.build({ id: 'asset-1', checksum: 'c3Vt', originalFileName: 'garden.jpg' });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(PetTagger, { asset, pets: [biscuit], petId: biscuit.id, onSaved, onClose });
    const image = screen.getByRole('img', { name: 'garden.jpg' });
    Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 800 } });
    await fireEvent.load(image);
    return { onSaved, onClose };
  };

  it('saves the whole photo without a region', async () => {
    const { onSaved } = await setup();

    await fireEvent.click(screen.getByRole('checkbox', { name: en.frameleaf_pet_tagger_whole_photo }));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pet_tagger_save }));

    await waitFor(() =>
      expect(sdkMock.createPetObservation).toHaveBeenCalledWith({
        id: biscuit.id,
        petObservationCreateDto: { assetId: 'asset-1', expectedChecksum: 'c3Vt' },
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(expect.anything(), biscuit, { id: 'asset-1', checksum: 'c3Vt' });
  });

  it('places a region, moves it with the keyboard and types its width', async () => {
    await setup();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pet_tagger_place }));
    const stage = screen.getByRole('application', { name: en.frameleaf_pet_tagger_stage });
    await fireEvent.keyDown(stage, { key: 'ArrowRight', shiftKey: true });
    await fireEvent.change(screen.getByRole('spinbutton', { name: en.frameleaf_pet_tagger_width }), {
      target: { value: '30' },
    });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pet_tagger_save }));

    // DEFAULT_FACE_BOX (x .35, y .3, h .25) moved right by .02, width typed as 30 %
    await waitFor(() =>
      expect(sdkMock.createPetObservation).toHaveBeenCalledWith({
        id: biscuit.id,
        petObservationCreateDto: {
          assetId: 'asset-1',
          expectedChecksum: 'c3Vt',
          boundingBoxX1: 370,
          boundingBoxY1: 240,
          boundingBoxX2: 670,
          boundingBoxY2: 440,
          imageWidth: 1000,
          imageHeight: 800,
        },
      }),
    );
  });

  it('accepts any position a drawn box rounds to, so the browser never blocks Save (LIB-11)', async () => {
    await setup();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pet_tagger_place }));
    // a dragged box rounds to 0.1 %, e.g. 33.3
    await fireEvent.change(screen.getByRole('spinbutton', { name: en.frameleaf_pet_tagger_x }), {
      target: { value: '33.3' },
    });

    for (const input of screen.getAllByRole('spinbutton')) {
      expect((input as HTMLInputElement).validity.stepMismatch).toBe(false);
    }
  });

  it('drops a region drawn on the previous photo when the viewer moves on', async () => {
    const asset = assetFactory.build({ id: 'asset-1', checksum: 'c3Vt', originalFileName: 'garden.jpg' });
    const props = { asset, pets: [biscuit], petId: biscuit.id, onSaved: vi.fn(), onClose: vi.fn() };
    const view = render(PetTagger, props);
    const image = screen.getByRole('img', { name: 'garden.jpg' });
    Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 800 } });
    await fireEvent.load(image);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pet_tagger_place }));
    expect(screen.getByRole('button', { name: en.frameleaf_pet_tagger_save })).toBeEnabled();

    await view.rerender({
      ...props,
      asset: assetFactory.build({ id: 'asset-2', checksum: 'b3Ro', originalFileName: 'beach.jpg' }),
    });

    expect(screen.getByRole('button', { name: en.frameleaf_pet_tagger_save })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pet_tagger_save }));
    expect(sdkMock.createPetObservation).not.toHaveBeenCalled();
  });

  it('drops a region drawn before the original was replaced', async () => {
    const asset = assetFactory.build({ id: 'asset-1', checksum: 'c3Vt', originalFileName: 'garden.jpg' });
    const props = { asset, pets: [biscuit], petId: biscuit.id, onSaved: vi.fn(), onClose: vi.fn() };
    const view = render(PetTagger, props);
    const image = screen.getByRole('img', { name: 'garden.jpg' });
    Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 800 } });
    await fireEvent.load(image);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pet_tagger_place }));

    await view.rerender({ ...props, asset: { ...asset, checksum: 'bmV3' } });

    expect(screen.getByRole('button', { name: en.frameleaf_pet_tagger_save })).toBeDisabled();
  });

  it('reloads the image after the original is replaced so a region can be placed again', async () => {
    const asset = assetFactory.build({ id: 'asset-1', checksum: 'c3Vt', originalFileName: 'garden.jpg' });
    const props = { asset, pets: [biscuit], petId: biscuit.id, onSaved: vi.fn(), onClose: vi.fn() };
    const view = render(PetTagger, props);
    const before = screen.getByRole('img', { name: 'garden.jpg' }).getAttribute('src');

    await view.rerender({ ...props, asset: { ...asset, checksum: 'bmV3' } });
    const image = screen.getByRole('img', { name: 'garden.jpg' });
    expect(image.getAttribute('src')).not.toBe(before);
    Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 800 } });
    await fireEvent.load(image);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pet_tagger_place }));

    expect(screen.getByRole('button', { name: en.frameleaf_pet_tagger_save })).toBeEnabled();
  });

  it('reports a save that finishes after the viewer moved on against the photo it was made on', async () => {
    const pending = deferredPromise<PetObservationResponseDto>();
    sdkMock.createPetObservation.mockReturnValue(pending.promise as ReturnType<typeof sdkMock.createPetObservation>);
    const asset = assetFactory.build({ id: 'asset-1', checksum: 'c3Vt', originalFileName: 'garden.jpg' });
    const onSaved = vi.fn();
    const props = { asset, pets: [biscuit], petId: biscuit.id, onSaved, onClose: vi.fn() };
    const view = render(PetTagger, props);
    await fireEvent.click(screen.getByRole('checkbox', { name: en.frameleaf_pet_tagger_whole_photo }));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pet_tagger_save }));

    await view.rerender({
      ...props,
      asset: assetFactory.build({ id: 'asset-2', checksum: 'b3Ro', originalFileName: 'beach.jpg' }),
    });
    const saved = { id: 'observation-1', assetId: 'asset-1' } as PetObservationResponseDto;
    pending.resolve(saved);

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved, biscuit, { id: 'asset-1', checksum: 'c3Vt' }));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(sdkMock.createPetObservation).toHaveBeenCalledWith({
      id: biscuit.id,
      petObservationCreateDto: { assetId: 'asset-1', expectedChecksum: 'c3Vt' },
    });
  });

  it('reports a failed save in a toast once the viewer has moved on', async () => {
    const warning = vi.spyOn(toastManager, 'warning');
    const pending = deferredPromise<PetObservationResponseDto>();
    sdkMock.createPetObservation.mockReturnValue(pending.promise as ReturnType<typeof sdkMock.createPetObservation>);
    const asset = assetFactory.build({ id: 'asset-1', checksum: 'c3Vt', originalFileName: 'garden.jpg' });
    const props = { asset, pets: [biscuit], petId: biscuit.id, onSaved: vi.fn(), onClose: vi.fn() };
    const view = render(PetTagger, props);
    await fireEvent.click(screen.getByRole('checkbox', { name: en.frameleaf_pet_tagger_whole_photo }));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pet_tagger_save }));

    await view.rerender({
      ...props,
      asset: assetFactory.build({ id: 'asset-2', checksum: 'b3Ro', originalFileName: 'beach.jpg' }),
    });
    pending.reject(new Error('offline'));

    await waitFor(() => expect(warning).toHaveBeenCalledWith(en.frameleaf_viewer_pets_error));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a save that fails after the dialog was closed in a toast', async () => {
    const warning = vi.spyOn(toastManager, 'warning');
    const pending = deferredPromise<PetObservationResponseDto>();
    sdkMock.createPetObservation.mockReturnValue(pending.promise as ReturnType<typeof sdkMock.createPetObservation>);
    const asset = assetFactory.build({ id: 'asset-1', checksum: 'c3Vt', originalFileName: 'garden.jpg' });
    const view = render(PetTagger, { asset, pets: [biscuit], petId: biscuit.id, onSaved: vi.fn(), onClose: vi.fn() });
    await fireEvent.click(screen.getByRole('checkbox', { name: en.frameleaf_pet_tagger_whole_photo }));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pet_tagger_save }));

    view.unmount();
    pending.reject(new Error('offline'));

    await waitFor(() => expect(warning).toHaveBeenCalledWith(en.frameleaf_viewer_pets_error));
  });

  it('keeps the dialog open and explains a photo that changed meanwhile', async () => {
    sdkMock.isHttpError.mockReturnValue(true);
    sdkMock.createPetObservation.mockRejectedValue({ status: 409 });
    const { onSaved } = await setup();

    await fireEvent.click(screen.getByRole('checkbox', { name: en.frameleaf_pet_tagger_whole_photo }));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pet_tagger_save }));

    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_pets_photo_changed);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
