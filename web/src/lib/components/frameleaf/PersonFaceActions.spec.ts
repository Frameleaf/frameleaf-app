import { createPerson, deleteFace, getAllPeople, reassignFacesById } from '@immich/sdk';
import { modalManager, toastManager } from '@immich/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { personFactory } from '@test-data/factories/person-factory';
import PersonFaceActions from './PersonFaceActions.svelte';

/**
 * FL-38: the inline per-person menu in the viewer's People section. Every assertion here
 * checks that an action reaches the real face/person endpoints (`reassignFacesById`,
 * `createPerson`, `deleteFace`) with the arguments those endpoints already define — never a
 * client-side derived view — and that "remove" vs "hide" map to `deleteFace`'s existing
 * `force` flag rather than a new contract.
 *
 * No locale is loaded in this test environment (see `src/test-data/setup.ts`), so `$t(key)`
 * renders the literal key rather than its English text — the same convention
 * `MarkNsfwAction.spec.ts` uses (`name: 'mark_nsfw'`). Matchers below use the i18n keys
 * from `i18n/en.json` for that reason; `candidate.name` / `person.name` are plain data, not
 * translated, so those stay as the factory-built values.
 */

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return {
    ...sdk,
    createPerson: vi.fn(),
    deleteFace: vi.fn(),
    getAllPeople: vi.fn(),
    reassignFacesById: vi.fn(),
  };
});

vi.mock('@immich/ui', async () => {
  const actual = await vi.importActual<typeof import('@immich/ui')>('@immich/ui');
  const { default: Icon } = await import('@test-data/components/MockIcon.svelte');
  return {
    ...actual,
    Icon,
    modalManager: { showDialog: vi.fn() },
    toastManager: { primary: vi.fn(), danger: vi.fn() },
  };
});

describe('PersonFaceActions', () => {
  const face = {
    id: 'face-1',
    imageHeight: 100,
    imageWidth: 100,
    boundingBoxX1: 0,
    boundingBoxX2: 1,
    boundingBoxY1: 0,
    boundingBoxY2: 1,
  } as never;

  const openMenu = async () => {
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_faces_options_for' }));
    expect(screen.getByRole('menu', { name: 'frameleaf_faces_options_for' })).toBeTruthy();
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reassigns the face to an existing person through reassignFacesById', async () => {
    const person = personFactory.build({ name: 'Alex', isHidden: false });
    const target = personFactory.build({ name: 'Bailey' });
    const onFacesChanged = vi.fn();
    vi.mocked(getAllPeople).mockResolvedValue({ people: [target], total: 1, hasNextPage: false });
    vi.mocked(reassignFacesById).mockResolvedValue(target);

    render(PersonFaceActions, { person, face, previousRoute: '/photos', onFacesChanged });

    await openMenu();
    await fireEvent.click(screen.getByRole('menuitem', { name: 'frameleaf_faces_reassign' }));
    await waitFor(() => expect(getAllPeople).toHaveBeenCalledWith({ withHidden: true, closestAssetId: face.id }));

    // Switching into the picker keeps the popup open (MenuItem's `keepOpen`), so the
    // candidate's own name — plain data, not a translated string — is still findable.
    await fireEvent.click(await screen.findByRole('menuitem', { name: target.name }));

    await waitFor(() => expect(reassignFacesById).toHaveBeenCalledWith({ id: target.id, faceDto: { id: face.id } }));
    expect(onFacesChanged).toHaveBeenCalled();
  });

  it('excludes the currently-assigned person from the reassign candidates', async () => {
    const person = personFactory.build({ name: 'Alex', isHidden: false });
    const target = personFactory.build({ name: 'Bailey' });
    vi.mocked(getAllPeople).mockResolvedValue({ people: [person, target], total: 2, hasNextPage: false });

    render(PersonFaceActions, { person, face, previousRoute: '/photos', onFacesChanged: vi.fn() });

    await openMenu();
    await fireEvent.click(screen.getByRole('menuitem', { name: 'frameleaf_faces_reassign' }));
    await waitFor(() => expect(getAllPeople).toHaveBeenCalled());
    await screen.findByRole('menuitem', { name: target.name });

    expect(screen.queryByRole('menuitem', { name: person.name })).toBeNull();
  });

  it('creates a new person and assigns the face to them', async () => {
    const person = personFactory.build({ name: 'Alex', isHidden: false });
    const created = personFactory.build({ name: 'New Person' });
    const onFacesChanged = vi.fn();
    vi.mocked(createPerson).mockResolvedValue(created);
    vi.mocked(reassignFacesById).mockResolvedValue(created);

    render(PersonFaceActions, { person, face, previousRoute: '/photos', onFacesChanged });

    await openMenu();
    await fireEvent.click(screen.getByRole('menuitem', { name: 'frameleaf_faces_create_new_person' }));
    await fireEvent.input(screen.getByLabelText('frameleaf_faces_new_person_name'), {
      target: { value: 'New Person' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'create_person' }));

    await waitFor(() => expect(createPerson).toHaveBeenCalledWith({ personCreateDto: { name: 'New Person' } }));
    expect(reassignFacesById).toHaveBeenCalledWith({ id: created.id, faceDto: { id: face.id } });
    expect(onFacesChanged).toHaveBeenCalled();
  });

  it('permanently deletes the face on Remove face, after confirming', async () => {
    const person = personFactory.build({ name: 'Alex', isHidden: false });
    const onFacesChanged = vi.fn();
    vi.mocked(modalManager.showDialog).mockResolvedValue(true);
    vi.mocked(deleteFace).mockResolvedValue(undefined as never);

    render(PersonFaceActions, { person, face, previousRoute: '/photos', onFacesChanged });

    await openMenu();
    await fireEvent.click(screen.getByRole('menuitem', { name: 'frameleaf_faces_remove_face' }));

    await waitFor(() => expect(modalManager.showDialog).toHaveBeenCalled());
    await waitFor(() => expect(deleteFace).toHaveBeenCalledWith({ id: face.id, assetFaceDeleteDto: { force: true } }));
    expect(onFacesChanged).toHaveBeenCalled();
  });

  it('does not delete the face when Remove face is cancelled', async () => {
    const person = personFactory.build({ name: 'Alex', isHidden: false });
    const onFacesChanged = vi.fn();
    vi.mocked(modalManager.showDialog).mockResolvedValue(false);

    render(PersonFaceActions, { person, face, previousRoute: '/photos', onFacesChanged });

    await openMenu();
    await fireEvent.click(screen.getByRole('menuitem', { name: 'frameleaf_faces_remove_face' }));

    await waitFor(() => expect(modalManager.showDialog).toHaveBeenCalled());
    expect(deleteFace).not.toHaveBeenCalled();
    expect(onFacesChanged).not.toHaveBeenCalled();
  });

  it('soft-deletes (hides) the face without a confirmation prompt', async () => {
    const person = personFactory.build({ name: 'Alex', isHidden: false });
    const onFacesChanged = vi.fn();
    vi.mocked(deleteFace).mockResolvedValue(undefined as never);

    render(PersonFaceActions, { person, face, previousRoute: '/photos', onFacesChanged });

    await openMenu();
    await fireEvent.click(screen.getByRole('menuitem', { name: 'frameleaf_faces_hide_face' }));

    expect(modalManager.showDialog).not.toHaveBeenCalled();
    await waitFor(() => expect(deleteFace).toHaveBeenCalledWith({ id: face.id, assetFaceDeleteDto: { force: false } }));
    expect(onFacesChanged).toHaveBeenCalled();
    expect(toastManager.primary).toHaveBeenCalled();
  });

  it('does not offer Hide face for a person who is already hidden', async () => {
    const person = personFactory.build({ name: 'Alex', isHidden: true });

    render(PersonFaceActions, { person, face, previousRoute: '/photos', onFacesChanged: vi.fn() });

    await openMenu();
    expect(screen.queryByRole('menuitem', { name: 'frameleaf_faces_hide_face' })).toBeNull();
    // Remove face has no such gate — it stays available even once the person is hidden.
    expect(screen.getByRole('menuitem', { name: 'frameleaf_faces_remove_face' })).toBeTruthy();
  });
});
