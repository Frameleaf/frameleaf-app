import type { AssetFaceResponseDto } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
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
const faces = vi.hoisted(() => ({ data: [] as AssetFaceResponseDto[] }));

vi.mock('$lib/stores/face.svelte', () => ({
  faceManager: {
    get data() {
      return faces.data;
    },
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

  beforeEach(() => {
    faces.data = [assigned, unassigned];
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
    expect(screen.getByText('frameleaf_faces_unnamed_person')).toBeInTheDocument();
    expect(screen.getAllByTestId('unassigned-face')).toHaveLength(1);
    // One chip menu per face: Alex's and the unnamed face's.
    expect(screen.getAllByRole('button', { name: 'frameleaf_faces_options_for' })).toHaveLength(2);
  });

  it('shows no unassigned faces or face menus to someone who does not own the asset', () => {
    renderPanel(false);

    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(screen.queryByText('frameleaf_faces_unnamed_person')).toBeNull();
    expect(screen.queryByRole('button', { name: 'frameleaf_faces_options_for' })).toBeNull();
  });

  it('counts an unassigned face as a person on the photo', () => {
    faces.data = [unassigned];
    renderPanel(true);

    expect(screen.queryByText('frameleaf_viewer_no_people')).toBeNull();
    expect(screen.getByText('frameleaf_faces_unnamed_person')).toBeInTheDocument();
  });
});
