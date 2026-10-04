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
      revision: `rev-${id}`,
      hiddenAt: null,
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
    sdkMock.correctFace.mockResolvedValue({} as never);
    const onChanged = vi.fn();
    const close = vi.fn();
    render(FixMatchPanel, { person, onChanged, close });

    await fireEvent.click(await screen.findByRole('button', { name: 'Not this person in one.jpg' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'This is Grace' }));

    await waitFor(() => expect(screen.getAllByText('Moved to Grace').length).toBeGreaterThan(0));
    expect(sdkMock.correctFace).toHaveBeenCalledWith({
      id: 'f1',
      assetFaceCorrectionDto: { expectedRevision: 'rev-f1', expectedPersonId: 'ada', personId: 'grace' },
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(['grace']);
    expect(close).toHaveBeenCalledOnce();
  });

  it('takes a face that is nobody off the person with a recoverable soft delete', async () => {
    sdkMock.deleteFace.mockResolvedValue(undefined as never);
    render(FixMatchPanel, { person, close: vi.fn() });

    await fireEvent.click(await screen.findByRole('button', { name: 'Not this person in one.jpg' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Not a face of anyone' }));

    await waitFor(() =>
      expect(sdkMock.deleteFace).toHaveBeenCalledWith({
        id: 'f1',
        assetFaceDeleteDto: { force: false, expectedRevision: 'rev-f1' },
      }),
    );
  });

  // FL-38: a move is revision-checked; when the face changed elsewhere it is read again, not overwritten
  it('reads the face again after a conflict and keeps it to retry at its new revision', async () => {
    sdkMock.correctFace.mockRejectedValueOnce({ status: 409 }).mockResolvedValueOnce({} as never);
    sdkMock.isHttpError.mockReturnValue(true);
    render(FixMatchPanel, { person, close: vi.fn() });

    await fireEvent.click(await screen.findByRole('button', { name: 'Not this person in one.jpg' }));
    sdkMock.getFaces.mockResolvedValueOnce([{ ...face('f1', 'ada'), revision: 'rev-newer' }]);
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'This is Grace' }));
    await waitFor(() => expect(sdkMock.getFaces).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Moved to Grace')).toBeNull();

    await fireEvent.click(await screen.findByRole('button', { name: 'Not this person in one.jpg' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'This is Grace' }));
    await waitFor(() =>
      expect(sdkMock.correctFace).toHaveBeenLastCalledWith({
        id: 'f1',
        assetFaceCorrectionDto: { expectedRevision: 'rev-newer', expectedPersonId: 'ada', personId: 'grace' },
      }),
    );
  });

  it('marks a face that moved elsewhere meanwhile as changed', async () => {
    sdkMock.deleteFace.mockRejectedValueOnce({ status: 409 });
    sdkMock.isHttpError.mockReturnValue(true);
    render(FixMatchPanel, { person, close: vi.fn() });

    await fireEvent.click(await screen.findByRole('button', { name: 'Not this person in one.jpg' }));
    sdkMock.getFaces.mockResolvedValueOnce([face('f1', 'someone-else')]);
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Not a face of anyone' }));

    expect(await screen.findByText('Changed in another view')).toBeTruthy();
  });

  it('does not skip photos on Show more after faces moved away', async () => {
    const page = (ids: string[], next: string | null) =>
      ({
        assets: { items: ids.map((id) => asset(id)), nextPage: next, nextCursor: null, count: 0, total: 0, facets: [] },
      }) as never;
    const ids = Array.from({ length: 25 }, (_, index) => `p${index}`);
    sdkMock.searchAssets.mockResolvedValueOnce(page(ids, '2'));
    sdkMock.getFaces.mockImplementation(({ id }) => Promise.resolve([face(`f-${id}`, 'ada')]));
    sdkMock.correctFace.mockResolvedValue({} as never);
    render(FixMatchPanel, { person, close: vi.fn() });

    await fireEvent.click(await screen.findByRole('button', { name: 'Not this person in p0.jpg' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'This is Grace' }));
    await waitFor(() => expect(sdkMock.correctFace).toHaveBeenCalledOnce());

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

  describe('selecting faces to split off (FL-57)', () => {
    const twoFaces = () => {
      sdkMock.searchAssets.mockResolvedValue({
        assets: {
          items: [asset('one'), asset('two')],
          nextPage: null,
          nextCursor: null,
          count: 2,
          total: 2,
          facets: [],
        },
      } as never);
      sdkMock.getFaces.mockImplementation(({ id }) => Promise.resolve([face(`f-${id}`, 'ada')]));
    };

    it('moves the selected faces to anyone found with the searchable picker', async () => {
      twoFaces();
      const lin = personFactory.build({ id: 'lin', name: 'Lin' });
      sdkMock.getAllPeople.mockResolvedValue({ people: [other], total: 1, hidden: 0, hasNextPage: true });
      sdkMock.searchPerson.mockResolvedValue([lin, person]);
      sdkMock.correctFace.mockResolvedValue({} as never);
      const onChanged = vi.fn();
      render(FixMatchPanel, { person, onChanged, close: vi.fn() });

      await fireEvent.click(await screen.findByRole('checkbox', { name: 'Select the face in one.jpg' }));
      await fireEvent.click(screen.getByRole('checkbox', { name: 'Select the face in two.jpg' }));
      expect(screen.getByText('2 faces selected')).toBeTruthy();

      await fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
      const search = await screen.findByRole('searchbox', { name: 'Find a person' });
      await fireEvent.input(search, { target: { value: 'Li' } });
      await waitFor(() => expect(sdkMock.searchPerson).toHaveBeenCalledWith({ name: 'Li', withHidden: true }));
      // the person the faces come from is never offered
      expect(screen.queryByRole('button', { name: 'Ada' })).toBeNull();
      await fireEvent.click(await screen.findByRole('button', { name: 'Lin' }));

      await waitFor(() => expect(sdkMock.correctFace).toHaveBeenCalledTimes(2));
      expect(sdkMock.correctFace).toHaveBeenCalledWith({
        id: 'f-one',
        assetFaceCorrectionDto: { expectedRevision: 'rev-f-one', expectedPersonId: 'ada', personId: 'lin' },
      });
      expect(sdkMock.correctFace).toHaveBeenCalledWith({
        id: 'f-two',
        assetFaceCorrectionDto: { expectedRevision: 'rev-f-two', expectedPersonId: 'ada', personId: 'lin' },
      });
      expect(await screen.findByText('2 faces moved to Lin')).toBeTruthy();
      expect(screen.queryByText('2 faces selected')).toBeNull();

      await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(onChanged).toHaveBeenCalledExactlyOnceWith(['lin']);
    });

    it('pages through everyone when nothing is typed', async () => {
      twoFaces();
      sdkMock.getAllPeople.mockResolvedValue({ people: [other], total: 60, hidden: 0, hasNextPage: true });
      render(FixMatchPanel, { person, close: vi.fn() });

      await fireEvent.click(await screen.findByRole('checkbox', { name: 'Select the face in one.jpg' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
      await fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));

      await waitFor(() => expect(sdkMock.getAllPeople).toHaveBeenCalledWith({ withHidden: true, page: 2, size: 50 }));
    });

    it('splits the selected faces into someone new', async () => {
      twoFaces();
      const created = personFactory.build({ id: 'new-one', name: 'Noor' });
      sdkMock.createPerson.mockResolvedValue(created);
      sdkMock.correctFace.mockResolvedValue({} as never);
      sdkMock.searchPerson.mockResolvedValue([]);
      render(FixMatchPanel, { person, close: vi.fn() });

      await fireEvent.click(await screen.findByRole('checkbox', { name: 'Select the face in one.jpg' }));
      await fireEvent.click(screen.getByRole('checkbox', { name: 'Select the face in two.jpg' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Someone new…' }));
      const name = await screen.findByRole('combobox', { name: 'Name for the new person' });
      await fireEvent.input(name, { target: { value: 'Noor' } });
      await fireEvent.submit(name.closest('form')!);

      await waitFor(() => expect(sdkMock.correctFace).toHaveBeenCalledTimes(2));
      expect(sdkMock.createPerson).toHaveBeenCalledExactlyOnceWith({ personCreateDto: { name: 'Noor' } });
    });

    it('takes the selected faces off as not a face of anyone, and keeps a failed one selected', async () => {
      twoFaces();
      sdkMock.deleteFace.mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(new Error('offline'));
      render(FixMatchPanel, { person, close: vi.fn() });

      await fireEvent.click(await screen.findByRole('checkbox', { name: 'Select the face in one.jpg' }));
      await fireEvent.click(screen.getByRole('checkbox', { name: 'Select the face in two.jpg' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Not a face of anyone' }));

      await waitFor(() => expect(sdkMock.deleteFace).toHaveBeenCalledTimes(2));
      expect(sdkMock.deleteFace).toHaveBeenCalledWith({
        id: 'f-one',
        assetFaceDeleteDto: { force: false, expectedRevision: 'rev-f-one' },
      });
      expect(await screen.findByText('1 face taken off this person')).toBeTruthy();
      expect(screen.getByText('1 face selected')).toBeTruthy();
    });
  });
});
