import type { AssetFaceResponseDto } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import { personFactory } from '@test-data/factories/person-factory';
import DetailPanelPeople from './DetailPanelPeople.svelte';

/**
 * FL-38 (V-22): the info panel's People section with the legacy "Edit people" pencil and
 * side panel removed. Every per-face action lives in the chip menu, so a detected face that
 * nobody is assigned to gets its own "Unnamed person" chip (media-viewer.mjs `peopleChips`).
 *
 * No locale is loaded here, so `$t(key)` renders the key itself.
 */
const faces = vi.hoisted(() => ({
  data: [] as AssetFaceResponseDto[],
  hidden: [] as AssetFaceResponseDto[],
  loadHiddenFaces: vi.fn(),
}));

vi.mock('$lib/stores/face.svelte', () => ({
  faceManager: {
    get data() {
      return faces.data;
    },
    get hiddenFaces() {
      return faces.hidden;
    },
    loadHiddenFaces: faces.loadHiddenFaces,
    get people() {
      return [...new Map(faces.data.flatMap((face) => (face.person ? [[face.person.id, face.person]] : []))).values()];
    },
    get facesByPersonId() {
      const map = new Map<string, AssetFaceResponseDto[]>();
      for (const face of faces.data) {
        if (face.person) {
          map.set(face.person.id, [...(map.get(face.person.id) ?? []), face]);
        }
      }
      return map;
    },
  },
}));

describe('DetailPanelPeople', () => {
  const alex = personFactory.build({ name: 'Alex', isHidden: false, birthDate: null });
  const box = {
    imageWidth: 1000,
    imageHeight: 800,
    boundingBoxX1: 100,
    boundingBoxY1: 80,
    boundingBoxX2: 300,
    boundingBoxY2: 280,
  };
  const assigned = { id: 'face-1', person: alex, ...box } as AssetFaceResponseDto;
  const unassigned = { id: 'face-2', person: null, ...box } as AssetFaceResponseDto;

  const hiddenFace = {
    id: 'face-3',
    person: null,
    hiddenAt: '2026-09-25T00:00:00.000Z',
    ...box,
  } as AssetFaceResponseDto;

  beforeEach(() => {
    faces.data = [assigned, unassigned];
    faces.hidden = [];
    faces.loadHiddenFaces.mockReset();
    assetViewerManager.hideHiddenPeople();
  });

  const renderPanel = (isOwner: boolean) =>
    render(DetailPanelPeople, {
      asset: assetFactory.build(),
      isOwner,
      previousRoute: '/photos',
      onFacesChanged: vi.fn(),
    });

  it('no longer offers the legacy Edit people panel', () => {
    renderPanel(true);

    expect(screen.queryByRole('button', { name: 'edit_people' })).toBeNull();
    expect(screen.getByRole('button', { name: 'frameleaf_viewer_add_person_label' })).toBeInTheDocument();
  });

  it('gives an unassigned face an Unnamed person chip with its own menu', () => {
    renderPanel(true);

    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(screen.getByText('unnamed_person')).toBeInTheDocument();
    expect(screen.getAllByTestId('unassigned-face')).toHaveLength(1);
    // One chip menu per face: Alex's and the unnamed face's.
    expect(screen.getAllByRole('button', { name: 'frameleaf_faces_options_for' })).toHaveLength(2);
  });

  it('shows no unassigned faces or face menus to someone who does not own the asset', () => {
    renderPanel(false);

    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(screen.queryByText('unnamed_person')).toBeNull();
    expect(screen.queryByRole('button', { name: 'frameleaf_faces_options_for' })).toBeNull();
  });

  it('counts an unassigned face as a person on the photo', () => {
    faces.data = [unassigned];
    renderPanel(true);

    expect(screen.queryByText('frameleaf_viewer_no_people')).toBeNull();
    expect(screen.getByText('unnamed_person')).toBeInTheDocument();
  });

  it('draws the people photos and unassigned face crops as squircles (FL-37)', () => {
    const { container } = renderPanel(true);

    // The photo (or its broken-image stand-in) sits inside a squircle backing that carries the highlight.
    const link = screen.getByText('Alex').closest('a') as HTMLElement;
    const backing = link.querySelector(':scope > .fl-squircle') as HTMLElement;
    expect(backing).not.toBeNull();
    expect(backing.querySelector('.fl-squircle')).not.toBeNull();
    const crop = screen.getByTestId('unassigned-face').querySelector(':scope [aria-hidden="true"]');
    expect(crop).toHaveClass('fl-squircle');
    expect(container.querySelector(':scope .rounded-full, :scope [class~="rounded-xl"] > img')).toBeNull();
  });

  it('re-reads the chips when a person on the photo changes elsewhere (FL-37)', async () => {
    const onFacesChanged = vi.fn();
    render(DetailPanelPeople, { asset: assetFactory.build(), isOwner: true, previousRoute: '/photos', onFacesChanged });

    eventManager.emit('PersonUpdate', { ...alex, name: 'Alexandra' });
    expect(onFacesChanged).toHaveBeenCalledOnce();

    // someone who is not on this photo changes nothing here
    eventManager.emit('PersonUpdate', personFactory.build({ id: 'somebody-else' }));
    expect(onFacesChanged).toHaveBeenCalledOnce();
  });

  it('re-reads the chips when faces move between people (FL-37)', async () => {
    const onFacesChanged = vi.fn().mockRejectedValue(new Error('offline'));
    render(DetailPanelPeople, {
      asset: assetFactory.build(),
      isOwner: false,
      previousRoute: '/photos',
      onFacesChanged,
    });

    eventManager.emit('PersonFacesChange', { personIds: ['someone'], removedPersonIds: ['someone'] });
    expect(onFacesChanged).toHaveBeenCalledOnce();
    // a failed re-read keeps the chips as they were
    expect(screen.getByText('Alex')).toBeInTheDocument();
  });

  it('loads the faces the owner hid and counts them toward Show hidden', async () => {
    faces.hidden = [hiddenFace];
    const { asset } = { asset: assetFactory.build() };
    render(DetailPanelPeople, { asset, isOwner: true, previousRoute: '/photos', onFacesChanged: vi.fn() });

    expect(faces.loadHiddenFaces).toHaveBeenCalledWith(asset.id);
    expect(screen.queryByTestId('hidden-face')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_viewer_show_hidden_people' }));

    const chip = screen.getByTestId('hidden-face');
    expect(chip).toHaveTextContent('unnamed_person');
    expect(screen.getByLabelText('frameleaf_faces_hidden_label')).toBeInTheDocument();
    // its menu offers Show face (PersonFaceActions), one menu per face
    expect(screen.getAllByRole('button', { name: 'frameleaf_faces_options_for' })).toHaveLength(3);
  });

  it('never asks for hidden faces for someone who does not own the asset', () => {
    renderPanel(false);
    expect(faces.loadHiddenFaces).not.toHaveBeenCalled();
  });
});
