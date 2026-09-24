import { AssetVisibility, SourceType, type AssetFaceResponseDto, type AssetResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { personFactory } from '@test-data/factories/person-factory';
import FixMatchPanel from './FixMatchPanel.svelte';

describe('FixMatchPanel (PD-3)', () => {
  const person = personFactory.build({ id: 'ada', name: 'Ada' });
  const other = { ...personFactory.build({ id: 'grace', name: 'Grace' }), assetCount: 3, lastSeenAt: null };
  const asset = (id: string, visibility = AssetVisibility.Timeline) =>
    ({ id, originalFileName: `${id}.jpg`, localDateTime: '2024-03-02T10:00:00.000Z', visibility }) as AssetResponseDto;
  const face = (id: string, personId: string, sourceType = SourceType.MachineLearning) =>
    ({
      id,
      boundingBoxX1: 10,
      boundingBoxY1: 10,
      boundingBoxX2: 50,
      boundingBoxY2: 50,
      imageWidth: 100,
      imageHeight: 100,
      sourceType,
      person: personFactory.build({ id: personId }),
    }) as AssetFaceResponseDto;

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.searchAssets.mockResolvedValue({
      assets: {
        items: [asset('one'), asset('locked', AssetVisibility.Locked)],
        nextPage: null,
        nextCursor: null,
        count: 2,
        total: 2,
        facets: [],
      },
    } as never);
    sdkMock.getFaces.mockImplementation(({ id }) =>
      Promise.resolve(id === 'one' ? [face('f1', 'ada'), face('f2', 'someone-else')] : [face('f3', 'ada')]),
    );
    sdkMock.getAllPeople.mockResolvedValue({ people: [other], total: 1, hidden: 0 });
  });

  it('lists only this person’s faces and never reads a Locked photo', async () => {
    render(FixMatchPanel, { person, close: vi.fn() });

    expect(await screen.findByText('one.jpg')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(sdkMock.getFaces).toHaveBeenCalledExactlyOnceWith({ id: 'one' });
    expect(screen.getByText('1 face to review')).toBeTruthy();
  });

  it('moves a face to another person and reports the change on close', async () => {
    sdkMock.reassignFacesById.mockResolvedValue(other);
    const onChanged = vi.fn();
    const close = vi.fn();
    render(FixMatchPanel, { person, onChanged, close });

    await fireEvent.click(await screen.findByRole('button', { name: 'Not this person in one.jpg' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'This is Grace' }));

    await waitFor(() => expect(screen.getAllByText('Moved to Grace').length).toBeGreaterThan(0));
    expect(sdkMock.reassignFacesById).toHaveBeenCalledWith({ id: 'grace', faceDto: { id: 'f1' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('takes a face that is nobody off the person with a recoverable soft delete', async () => {
    sdkMock.deleteFace.mockResolvedValue(undefined as never);
    render(FixMatchPanel, { person, close: vi.fn() });

    await fireEvent.click(await screen.findByRole('button', { name: 'Not this person in one.jpg' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Not a face of anyone' }));

    await waitFor(() =>
      expect(sdkMock.deleteFace).toHaveBeenCalledWith({ id: 'f1', assetFaceDeleteDto: { force: false } }),
    );
  });

  it('does not skip photos on Show more after faces moved away', async () => {
    const page = (ids: string[], next: string | null) =>
      ({
        assets: { items: ids.map((id) => asset(id)), nextPage: next, nextCursor: null, count: 0, total: 0, facets: [] },
      }) as never;
    const ids = Array.from({ length: 25 }, (_, index) => `p${index}`);
    sdkMock.searchAssets.mockResolvedValueOnce(page(ids, '2'));
    sdkMock.getFaces.mockImplementation(({ id }) => Promise.resolve([face(`f-${id}`, 'ada')]));
    sdkMock.reassignFacesById.mockResolvedValue(other);
    render(FixMatchPanel, { person, close: vi.fn() });

    await fireEvent.click(await screen.findByRole('button', { name: 'Not this person in p0.jpg' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'This is Grace' }));
    await waitFor(() => expect(sdkMock.reassignFacesById).toHaveBeenCalledOnce());

    // p0 left the results, so the server's page 2 now starts one photo later: reading page 1 again
    // finds the photo that shifted onto it.
    sdkMock.searchAssets.mockResolvedValueOnce(page([...ids.slice(1), 'shifted'], '2'));
    sdkMock.searchAssets.mockResolvedValueOnce(page(['late'], null));
    await fireEvent.click(screen.getByRole('button', { name: 'Show more' }));

    expect(await screen.findByText('shifted.jpg')).toBeTruthy();
    expect(await screen.findByText('late.jpg')).toBeTruthy();
    expect(sdkMock.searchAssets).toHaveBeenNthCalledWith(2, {
      metadataSearchDto: expect.objectContaining({ page: 1 }),
    });
  });
});
