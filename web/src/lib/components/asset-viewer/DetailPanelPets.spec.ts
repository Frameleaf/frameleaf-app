import {
  AssetVisibility,
  PetObservationSource,
  PetObservationState,
  PetSpecies,
  type PetObservationResponseDto,
  type PetResponseDto,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';
import DetailPanelPets from './DetailPanelPets.svelte';

/**
 * FL-58: "Pets in this photo". Owner-only, never on a shared link or a Locked photo in an ordinary
 * session; adding and removing offer Undo; every write names the photo's checksum.
 */
describe('DetailPanelPets', () => {
  const owner = userAdminFactory.build();
  const pet = (overrides: Partial<PetResponseDto> = {}): PetResponseDto => ({
    id: 'pet-biscuit',
    name: 'Biscuit',
    species: PetSpecies.Cat,
    birthDate: null,
    featuredAssetId: null,
    isHidden: false,
    isFavorite: false,
    assetCount: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  });
  const observation = (overrides: Partial<PetObservationResponseDto> = {}): PetObservationResponseDto => ({
    id: 'observation-1',
    petId: 'pet-biscuit',
    assetId: 'asset-1',
    state: PetObservationState.Confirmed,
    source: PetObservationSource.Manual,
    boundingBoxX1: null,
    boundingBoxY1: null,
    boundingBoxX2: null,
    boundingBoxY2: null,
    imageWidth: null,
    imageHeight: null,
    sourceChecksum: 'c3VtCg==',
    staleAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  });

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.resetAllMocks();
    authManager.setUser(owner);
    authManager.setPreferences(preferencesFactory.build());
    sdkMock.getAllPets.mockResolvedValue([pet(), pet({ id: 'pet-rex', name: 'Rex', species: PetSpecies.Dog })]);
    sdkMock.getAssetPetObservations.mockResolvedValue([]);
    sdkMock.createPetObservation.mockResolvedValue(observation());
    sdkMock.deletePetObservation.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    authManager.reset();
  });

  const setup = (overrides: Parameters<typeof assetFactory.build>[0] = {}, isOwner = true) => {
    const asset = assetFactory.build({ id: 'asset-1', ownerId: owner.id, checksum: 'c3VtCg==', ...overrides });
    render(DetailPanelPets, { asset, isOwner });
    return asset;
  };

  it('lists the pets confirmed in the photo, a changed region flagged', async () => {
    sdkMock.getAssetPetObservations.mockResolvedValue([
      observation({ boundingBoxX1: 1, staleAt: '2026-09-02T00:00:00.000Z' }),
    ]);

    setup();

    expect(await screen.findByText('Biscuit')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_viewer_pets_stale)).toBeInTheDocument();
    expect(sdkMock.getAssetPetObservations).toHaveBeenCalledWith({ assetId: 'asset-1' });
  });

  it('marks the whole photo with the checksum of the photo on screen, and Undo removes it', async () => {
    const toast = vi.spyOn(toastManager, 'primary');
    setup();

    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_viewer_pets_add_label }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Rex' }));

    await waitFor(() =>
      expect(sdkMock.createPetObservation).toHaveBeenCalledWith({
        id: 'pet-rex',
        petObservationCreateDto: { assetId: 'asset-1', expectedChecksum: 'c3VtCg==' },
      }),
    );
    const [[item]] = toast.mock.calls as unknown as [[{ button: { onclick: () => void } }]];
    item.button.onclick();
    await waitFor(() =>
      expect(sdkMock.deletePetObservation).toHaveBeenCalledWith({ id: 'observation-1', expectedChecksum: 'c3VtCg==' }),
    );
  });

  it('removes a pet and offers to put it back', async () => {
    sdkMock.getAssetPetObservations.mockResolvedValue([observation()]);
    const toast = vi.spyOn(toastManager, 'primary');
    setup();

    await fireEvent.click(await screen.findByRole('button', { name: 'Remove Biscuit from this photo' }));

    await waitFor(() => expect(sdkMock.deletePetObservation).toHaveBeenCalled());
    const [[item]] = toast.mock.calls as unknown as [[{ button: { onclick: () => void } }]];
    item.button.onclick();
    await waitFor(() =>
      expect(sdkMock.createPetObservation).toHaveBeenCalledWith({
        id: 'pet-biscuit',
        petObservationCreateDto: { assetId: 'asset-1', expectedChecksum: 'c3VtCg==' },
      }),
    );
  });

  it('says so when the original changed since the photo was opened', async () => {
    const warning = vi.spyOn(toastManager, 'warning');
    sdkMock.isHttpError.mockReturnValue(true);
    sdkMock.createPetObservation.mockRejectedValue({ status: 409 });
    setup();

    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_viewer_pets_add_label }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Biscuit' }));

    await waitFor(() => expect(warning).toHaveBeenCalledWith(en.frameleaf_pets_photo_changed));
  });

  it('shows nothing to anyone but the owner', () => {
    setup({}, false);

    expect(screen.queryByTestId('viewer-pets')).not.toBeInTheDocument();
    expect(sdkMock.getAssetPetObservations).not.toHaveBeenCalled();
  });

  it('never reveals a Locked photo’s pets in an ordinary session', () => {
    setup({ visibility: AssetVisibility.Locked });

    expect(screen.queryByTestId('viewer-pets')).not.toBeInTheDocument();
    expect(sdkMock.getAllPets).not.toHaveBeenCalled();
  });
});
