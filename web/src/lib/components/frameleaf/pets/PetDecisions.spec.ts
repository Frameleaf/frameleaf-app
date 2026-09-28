import { PetObservationSource, PetObservationState, type PetObservationResponseDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import PetDecisions from './PetDecisions.svelte';

/** FL-58: a pet's decisions, with remove and Undo, and review of regions on replaced photos. */
describe('PetDecisions', () => {
  const observation = (overrides: Partial<PetObservationResponseDto> = {}): PetObservationResponseDto => ({
    id: 'observation-1',
    petId: 'pet-biscuit',
    assetId: 'asset-1',
    state: PetObservationState.Confirmed,
    source: PetObservationSource.Review,
    boundingBoxX1: null,
    boundingBoxY1: null,
    boundingBoxX2: null,
    boundingBoxY2: null,
    imageWidth: null,
    imageHeight: null,
    sourceChecksum: 'c3Vt',
    staleAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  });
  const stale = observation({
    id: 'observation-stale',
    assetId: 'asset-2',
    source: PetObservationSource.Manual,
    boundingBoxX1: 10,
    boundingBoxY1: 10,
    boundingBoxX2: 90,
    boundingBoxY2: 90,
    imageWidth: 100,
    imageHeight: 100,
    staleAt: '2026-09-03T00:00:00.000Z',
  });

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getPetObservations.mockResolvedValue([observation(), stale]);
    sdkMock.deletePetObservation.mockResolvedValue(undefined as never);
  });

  it('lists regions on replaced photos first and keeps one for the whole photo', async () => {
    sdkMock.createPetObservation.mockResolvedValue({ ...stale, boundingBoxX1: null, staleAt: null });
    render(PetDecisions, { petId: 'pet-biscuit' });

    const rows = await screen.findAllByTestId('pet-decision');
    expect(rows[0]).toHaveTextContent(en.frameleaf_pet_decision_stale);

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pet_decision_keep_whole }));
    await waitFor(() =>
      expect(sdkMock.createPetObservation).toHaveBeenCalledWith({
        id: 'pet-biscuit',
        petObservationCreateDto: { assetId: 'asset-2' },
      }),
    );
  });

  it('removes a current decision naming its photo, and Undo writes it back', async () => {
    const toast = vi.spyOn(toastManager, 'primary');
    const onChanged = vi.fn();
    render(PetDecisions, { petId: 'pet-biscuit', onChanged });

    await screen.findAllByTestId('pet-decision');
    const remove = screen.getAllByRole('button', { name: en.frameleaf_pet_decision_remove });
    await fireEvent.click(remove[1]);

    await waitFor(() =>
      expect(sdkMock.deletePetObservation).toHaveBeenCalledWith({ id: 'observation-1', expectedChecksum: 'c3Vt' }),
    );
    expect(onChanged).toHaveBeenCalled();
    const [[item]] = toast.mock.calls as unknown as [[{ button: { onclick: () => void } }]];
    item.button.onclick();
    await waitFor(() =>
      expect(sdkMock.createPetObservation).toHaveBeenCalledWith({
        id: 'pet-biscuit',
        petObservationCreateDto: { assetId: 'asset-1', expectedChecksum: 'c3Vt' },
      }),
    );
  });
});
