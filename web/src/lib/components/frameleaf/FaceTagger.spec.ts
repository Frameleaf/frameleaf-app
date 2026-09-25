import {
  AssetTypeEnum,
  AssetVisibility,
  SourceType,
  type AssetFaceResponseDto,
  type PersonResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import { peopleListItemFactory, personFactory } from '@test-data/factories/person-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';
import FaceTagger from './FaceTagger.svelte';

/**
 * FL-38 (V-28): the face tagger dialog ported from FaceTagger.jsx. Existing faces load with
 * their provenance and revision and can be moved, resized, reassigned, unassigned or removed;
 * every change is saved revision-checked through the real face and person endpoints, and a
 * refused (409) save keeps the draft behind the prototype's stale banner.
 */
describe('FaceTagger', () => {
  const owner = userAdminFactory.build();
  const alex = peopleListItemFactory.build({ name: 'Alex', isHidden: false });
  const bailey = peopleListItemFactory.build({ name: 'Bailey', isHidden: false });
  const detectedFace = {
    id: 'face-1',
    imageWidth: 1000,
    imageHeight: 800,
    boundingBoxX1: 100,
    boundingBoxY1: 80,
    boundingBoxX2: 300,
    boundingBoxY2: 280,
    revision: 'rev-1',
    sourceType: SourceType.MachineLearning,
    correctedAt: null,
    hiddenAt: null,
    person: alex,
  } as AssetFaceResponseDto;
  const conflict = Object.assign(new Error('conflict'), { status: 409 });

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
    authManager.setUser(owner);
    authManager.setPreferences(preferencesFactory.build());
    sdkMock.getAllPeople.mockResolvedValue({ people: [alex, bailey], total: 2, hidden: 0, hasNextPage: false });
    sdkMock.getFaces.mockResolvedValue([detectedFace]);
    sdkMock.getFaceSource.mockResolvedValue({ assetId: 'asset', revision: 'src-1' });
    sdkMock.createFace.mockResolvedValue(detectedFace);
    sdkMock.deleteFace.mockResolvedValue(undefined as never);
    sdkMock.correctFace.mockResolvedValue(detectedFace);
    sdkMock.isHttpError.mockImplementation((error) => (error as { status?: number })?.status === 409);
  });

  afterEach(() => {
    authManager.reset();
  });

  const setup = async (overrides: Parameters<typeof assetFactory.build>[0] = {}) => {
    const asset = assetFactory.build({
      ownerId: owner.id,
      type: AssetTypeEnum.Image,
      originalFileName: 'beach.jpg',
      ...overrides,
    });
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(FaceTagger, { asset, onClose, onSaved });
    const image = screen.queryByRole('img', { name: 'beach.jpg' });
    if (image) {
      Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 800 } });
      await fireEvent.load(image);
    }
    await waitFor(() => expect(sdkMock.getFaces).toHaveBeenCalledWith({ id: asset.id }));
    await screen.findByText(en.frameleaf_face_tagger_position_note);
    return { asset, onClose, onSaved };
  };

  const save = () => screen.getByRole('button', { name: en.frameleaf_face_tagger_save });
  const pickPerson = (person: PersonResponseDto) =>
    fireEvent.click(screen.getByRole('button', { name: person.name, pressed: false }));

  it('shows the title, file name and the asset’s detected faces as editable regions with their provenance', async () => {
    await setup();

    expect(screen.getByRole('heading', { name: en.frameleaf_face_tagger_title })).toBeInTheDocument();
    expect(screen.getByText('beach.jpg')).toBeInTheDocument();
    expect(screen.getByText('1 face')).toBeInTheDocument();
    const list = screen.getByRole('group', { name: en.frameleaf_face_tagger_faces_list });
    expect(list).toHaveTextContent('Alex');
    expect(list).toHaveTextContent(en.frameleaf_face_provenance_detected);
    expect(screen.getByLabelText(en.frameleaf_face_tagger_left)).toBeEnabled();
    expect(screen.getByLabelText(en.frameleaf_face_tagger_left)).toHaveValue(10);
    expect(sdkMock.getFaceSource).toHaveBeenCalledWith({ id: expect.any(String) });
    expect(screen.getByText(en.frameleaf_face_tagger_status_idle)).toBeInTheDocument();
    expect(sdkMock.getAllPeople).toHaveBeenCalledWith({ page: 1, size: 1000, withHidden: false });
  });

  it('labels a video with the frame it is tagged on: the preview still, for the whole video', async () => {
    await setup({ type: AssetTypeEnum.Video });

    expect(
      screen.getByText('beach.jpg · Video preview still. Tags apply to the whole video, not to a moment in it.'),
    ).toBeInTheDocument();
  });

  it('tells manual and corrected faces apart from detected ones', async () => {
    sdkMock.getFaces.mockResolvedValue([
      { ...detectedFace, id: 'm', sourceType: SourceType.Manual },
      { ...detectedFace, id: 'c', correctedAt: '2026-09-25T00:00:00.000Z' },
    ]);
    await setup();

    const list = screen.getByRole('group', { name: en.frameleaf_face_tagger_faces_list });
    expect(list).toHaveTextContent(en.frameleaf_face_provenance_manual);
    expect(list).toHaveTextContent(en.frameleaf_face_provenance_corrected);
    expect(list).not.toHaveTextContent(en.frameleaf_face_provenance_detected);
  });

  it('closes straight away for an asset the viewer does not own', async () => {
    const asset = assetFactory.build({ ownerId: 'someone-else', originalFileName: 'beach.jpg' });
    const onClose = vi.fn();
    render(FaceTagger, { asset, onClose, onSaved: vi.fn() });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('closes for a locked asset while the session is not unlocked', async () => {
    const asset = assetFactory.build({ ownerId: owner.id, visibility: AssetVisibility.Locked });
    const onClose = vi.fn();
    render(FaceTagger, { asset, onClose, onSaved: vi.fn() });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('adds a region, edits its position, assigns a person and saves it in pixels', async () => {
    const { asset, onClose, onSaved } = await setup();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_face_tagger_add_face }));
    expect(screen.getByText('2 faces')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_face_tagger_status_choose)).toBeInTheDocument();
    expect(save()).toBeDisabled();

    await fireEvent.input(screen.getByLabelText(en.frameleaf_face_tagger_left), { target: { value: '10' } });
    await pickPerson(bailey);
    expect(screen.getByText(en.frameleaf_face_tagger_status_ready)).toBeInTheDocument();

    await fireEvent.click(save());

    await waitFor(() =>
      expect(sdkMock.createFace).toHaveBeenCalledWith({
        assetFaceCreateDto: {
          assetId: asset.id,
          personId: bailey.id,
          imageWidth: 1000,
          imageHeight: 800,
          x: 100,
          y: 240,
          width: 200,
          height: 200,
          expectedSourceRevision: 'src-1',
        },
      }),
    );
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(sdkMock.deleteFace).not.toHaveBeenCalled();
    expect(sdkMock.correctFace).not.toHaveBeenCalled();
  });

  it('moves and resizes a detected face with the keyboard and position fields, saved as a correction', async () => {
    const { onClose } = await setup();
    const dialog = screen.getByRole('dialog', { hidden: true });

    await fireEvent.keyDown(dialog, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByLabelText(en.frameleaf_face_tagger_left)).toHaveValue(12);
    await fireEvent.input(screen.getByLabelText(en.frameleaf_face_tagger_width), { target: { value: '25' } });
    await fireEvent.change(screen.getByLabelText(en.frameleaf_face_tagger_width));
    expect(screen.getByRole('group', { name: en.frameleaf_face_tagger_faces_list })).toHaveTextContent(
      en.frameleaf_face_provenance_corrected,
    );

    await fireEvent.click(save());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sdkMock.correctFace).toHaveBeenCalledWith({
      id: 'face-1',
      assetFaceCorrectionDto: {
        expectedRevision: 'rev-1',
        expectedSourceRevision: 'src-1',
        box: { imageWidth: 1000, imageHeight: 800, x: 120, y: 80, width: 250, height: 200 },
      },
    });
  });

  it('unassigns a detected face', async () => {
    const { onClose } = await setup();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_face_tagger_unassign }));
    expect(screen.getByRole('group', { name: en.frameleaf_face_tagger_faces_list })).toHaveTextContent(
      en.frameleaf_face_tagger_unnamed_person,
    );
    await fireEvent.click(save());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sdkMock.correctFace).toHaveBeenCalledWith({
      id: 'face-1',
      assetFaceCorrectionDto: { expectedRevision: 'rev-1', personId: null },
    });
  });

  it('keeps the draft and shows the stale banner when another editor changed a face (409)', async () => {
    sdkMock.correctFace.mockRejectedValue(conflict);
    const { onClose } = await setup();
    await pickPerson(bailey);

    await fireEvent.click(save());

    expect(await screen.findByText(en.frameleaf_face_tagger_stale)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(save()).toBeDisabled();
    // the unsaved reassignment is still on screen
    expect(screen.getByRole('button', { name: bailey.name, pressed: true })).toBeInTheDocument();

    sdkMock.getFaces.mockResolvedValue([{ ...detectedFace, revision: 'rev-2', person: null }]);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_face_tagger_load_latest }));

    await waitFor(() => expect(screen.queryByText(en.frameleaf_face_tagger_stale)).toBeNull());
    expect(screen.getByRole('group', { name: en.frameleaf_face_tagger_faces_list })).toHaveTextContent(
      en.frameleaf_face_tagger_unnamed_person,
    );
  });

  it('refuses a new region when the image changed since the dialog opened', async () => {
    sdkMock.createFace.mockRejectedValue(conflict);
    const { onClose } = await setup();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_face_tagger_add_face }));
    await pickPerson(bailey);
    sdkMock.getFaceSource.mockResolvedValue({ assetId: 'asset', revision: 'src-2' });

    await fireEvent.click(save());

    expect(await screen.findByText(en.frameleaf_face_tagger_stale_source)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('2 faces')).toBeInTheDocument();
  });

  it('moves the selected new region with arrow keys and resizes it with Alt (no pointer needed)', async () => {
    await setup();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_face_tagger_add_face }));
    const dialog = screen.getByRole('dialog', { hidden: true });

    await fireEvent.keyDown(dialog, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByLabelText(en.frameleaf_face_tagger_left)).toHaveValue(37);
    await fireEvent.keyDown(dialog, { key: 'ArrowDown', altKey: true });
    expect(screen.getByLabelText(en.frameleaf_face_tagger_height)).toHaveValue(25.5);
  });

  it('undoes the last change', async () => {
    await setup();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_face_tagger_add_face }));
    expect(screen.getByText('2 faces')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.undo }));

    expect(screen.getByText('1 face')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.undo })).toBeDisabled();
  });

  it('reassigns and removes detected faces in one revision-checked batch save', async () => {
    const second = { ...detectedFace, id: 'face-2', revision: 'rev-2', person: null };
    sdkMock.getFaces.mockResolvedValue([detectedFace, second]);
    const { onClose } = await setup();

    await pickPerson(bailey);
    await fireEvent.click(
      screen.getByRole('button', {
        name: `2 ${en.frameleaf_face_tagger_unnamed_person} ${en.frameleaf_face_provenance_detected}`,
      }),
    );
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_faces_remove_face }));
    expect(screen.getByText('1 face')).toBeInTheDocument();

    await fireEvent.click(save());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sdkMock.correctFace).toHaveBeenCalledWith({
      id: 'face-1',
      assetFaceCorrectionDto: { expectedRevision: 'rev-1', personId: bailey.id },
    });
    expect(sdkMock.deleteFace).toHaveBeenCalledWith({
      id: 'face-2',
      assetFaceDeleteDto: { force: true, expectedRevision: 'rev-2' },
    });
    expect(sdkMock.createFace).not.toHaveBeenCalled();
  });

  it('creates a person inline and only sends them to the server on save', async () => {
    const created = personFactory.build({ name: 'Casey' });
    sdkMock.createPerson.mockResolvedValue(created);
    await setup();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_face_tagger_add_face }));

    await fireEvent.click(screen.getByRole('button', { name: en.create_person }));
    await fireEvent.input(screen.getByLabelText(en.frameleaf_faces_new_person_name), { target: { value: 'alex' } });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_face_tagger_create_and_assign }));
    expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_face_tagger_error_duplicate_name);

    await fireEvent.input(screen.getByLabelText(en.frameleaf_faces_new_person_name), { target: { value: 'Casey' } });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_face_tagger_create_and_assign }));
    expect(sdkMock.createPerson).not.toHaveBeenCalled();

    await fireEvent.click(save());

    await waitFor(() => expect(sdkMock.createPerson).toHaveBeenCalledWith({ personCreateDto: { name: 'Casey' } }));
    await waitFor(() =>
      expect(sdkMock.createFace).toHaveBeenCalledWith({
        assetFaceCreateDto: expect.objectContaining({ personId: created.id }),
      }),
    );
  });

  it('keeps the dialog open with the unsaved changes when part of the save fails', async () => {
    sdkMock.createFace.mockRejectedValue(new Error('boom'));
    const { onClose, onSaved } = await setup();
    await pickPerson(bailey);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_face_tagger_add_face }));
    await pickPerson(alex);
    sdkMock.getFaces.mockResolvedValue([{ ...detectedFace, revision: 'rev-2', person: bailey }]);

    await fireEvent.click(save());

    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_face_tagger_error_save);
    expect(onClose).not.toHaveBeenCalled();
    // The reassignment landed, so the viewer refreshes and a retry only re-sends the new region.
    expect(onSaved).toHaveBeenCalled();
    expect(screen.getByText('2 faces')).toBeInTheDocument();
    sdkMock.createFace.mockResolvedValue(detectedFace);
    sdkMock.correctFace.mockClear();

    await fireEvent.click(save());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sdkMock.correctFace).not.toHaveBeenCalled();
    expect(sdkMock.createFace).toHaveBeenCalledTimes(2);
  });

  it('closes on Cancel', async () => {
    const { onClose } = await setup();

    await fireEvent.click(screen.getByRole('button', { name: en.cancel }));

    expect(onClose).toHaveBeenCalled();
  });

  it('makes one undo step per typed position edit', async () => {
    await setup();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_face_tagger_add_face }));
    const left = screen.getByLabelText(en.frameleaf_face_tagger_left);
    const before = (left as HTMLInputElement).value;

    await fireEvent.input(left, { target: { value: '1' } });
    await fireEvent.input(left, { target: { value: '12' } });
    await fireEvent.input(left, { target: { value: '12.5' } });
    await fireEvent.change(left);
    expect(left).toHaveValue(12.5);

    await fireEvent.click(screen.getByRole('button', { name: en.undo }));
    expect(screen.getByLabelText(en.frameleaf_face_tagger_left)).toHaveValue(Number(before));
  });

  it('closes at once from Cancel even with unsaved face tags (FaceTagger.jsx:731)', async () => {
    const { onClose } = await setup();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_face_tagger_add_face }));

    await fireEvent.click(screen.getByRole('button', { name: en.cancel }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('closes at once from Escape even with unsaved face tags (FaceTagger.jsx:316-318)', async () => {
    const { onClose } = await setup();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_face_tagger_add_face }));

    await fireEvent.keyDown(screen.getByRole('heading', { name: en.frameleaf_face_tagger_title }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes when nothing changed', async () => {
    const { onClose } = await setup();

    await fireEvent.click(screen.getByRole('button', { name: en.cancel }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
