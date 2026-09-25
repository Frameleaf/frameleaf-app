import {
  AssetTypeEnum,
  Status,
  Status2,
  type AssetImageEnrichmentResponseDto,
  type AssetResponseDto,
  type ExifResponseDto,
} from '@immich/sdk';
import {
  coordinateLabel,
  coordinatesOf,
  descriptionReview,
  infoDetailRows,
  locationLabel,
  osmLink,
  ownerLine,
  sensitivityReview,
  tagSuggestions,
  validCoordinate,
} from '$lib/frameleaf/info-panel';

const asset = (overrides: Partial<AssetResponseDto> = {}): AssetResponseDto =>
  ({
    id: 'asset-1',
    type: AssetTypeEnum.Image,
    checksum: 'c2hhMjU2',
    originalFileName: 'DSC_0001.jpg',
    originalPath: 'upload/library/admin/2026/DSC_0001.jpg',
    duration: null,
    width: 6000,
    height: 4000,
    ...overrides,
  }) as AssetResponseDto;

const exif = (overrides: Partial<ExifResponseDto> = {}): ExifResponseDto => ({ ...overrides });

const enrichment = (overrides: Partial<AssetImageEnrichmentResponseDto> = {}): AssetImageEnrichmentResponseDto =>
  ({
    assetId: 'asset-1',
    description: { status: Status.Missing, appliedDescription: false, appliedTags: false },
    nsfwDetection: { status: Status2.Missing, effectiveIsNsfw: false, appliedTags: false },
    ...overrides,
  }) as AssetImageEnrichmentResponseDto;

describe('coordinates', () => {
  it('rejects a value outside its axis', () => {
    expect(validCoordinate(91, 90)).toBeNull();
    expect(validCoordinate(-181, 180)).toBeNull();
    expect(validCoordinate(45.5, 90)).toBe(45.5);
  });

  it('rejects anything that is not a finite number', () => {
    expect(validCoordinate(NaN, 90)).toBeNull();
    expect(validCoordinate(null, 90)).toBeNull();
    expect(validCoordinate('nowhere', 90)).toBeNull();
  });

  it('treats null island as no fix rather than a place on the equator', () => {
    expect(coordinatesOf(exif({ latitude: 0, longitude: 0 }))).toBeNull();
  });

  it('needs both halves of a coordinate', () => {
    expect(coordinatesOf(exif({ latitude: 48.85 }))).toBeNull();
    expect(coordinatesOf(exif({ latitude: 48.85, longitude: 2.35 }))).toEqual({ lat: 48.85, lng: 2.35 });
  });

  it('formats coordinates and links them to OpenStreetMap, or neither', () => {
    const point = coordinatesOf(exif({ latitude: 48.8584, longitude: 2.2945 }));

    expect(coordinateLabel(point)).toBe('48.8584, 2.2945');
    expect(osmLink(point)).toContain('openstreetmap.org/?mlat=48.8584&mlon=2.2945');
    expect(osmLink(null)).toBeNull();
    expect(coordinateLabel(null)).toBeNull();
  });

  it('joins only the place parts the asset carries', () => {
    expect(locationLabel(exif({ city: 'Paris', country: 'France' }))).toBe('Paris, France');
    expect(locationLabel(exif())).toBeNull();
  });
});

describe('descriptionReview', () => {
  it('is absent when the asset has no enrichment record at all', () => {
    expect(descriptionReview(asset(), undefined)).toBeNull();
  });

  it('reads a stored description the owner wrote as manual', () => {
    const review = descriptionReview(asset({ exifInfo: exif({ description: 'Grandma at the lake' }) }), enrichment());

    expect(review?.source).toBe('manual');
    expect(review?.canAccept).toBe(false);
    expect(review?.canClear).toBe(false);
  });

  // FL-36 AI provenance: the model's confidence, as a percentage, only when the server reported one.
  it('reports the description confidence as a whole percentage when present', () => {
    const withConfidence = (confidence: number | null) =>
      descriptionReview(
        asset({ exifInfo: exif({ description: 'A lake at dusk' }) }),
        enrichment({
          description: {
            status: Status.Success,
            appliedDescription: true,
            appliedTags: false,
            description: 'A lake at dusk',
            confidence,
          },
        }),
      )?.confidencePercent;

    expect(withConfidence(0.873)).toBe(87);
    expect(withConfidence(1)).toBe(100);
    expect(withConfidence(null)).toBeNull();
    expect(withConfidence(NaN)).toBeNull();
  });

  it('reads an applied generated description as generated', () => {
    const review = descriptionReview(
      asset({ exifInfo: exif({ description: 'A lake at dusk' }) }),
      enrichment({
        description: {
          status: Status.Success,
          appliedDescription: true,
          appliedTags: false,
          description: 'A lake at dusk',
          modelName: 'model-a',
        },
      }),
    );

    expect(review?.source).toBe('generated');
    expect(review?.modelName).toBe('model-a');
    // No confidence was reported, so none is shown (the field is nullable).
    expect(review?.confidencePercent).toBeNull();
    // Nothing to accept: the suggestion is already what is stored.
    expect(review?.canAccept).toBe(false);
    expect(review?.suggestion).toBeNull();
    // The server applied it, so clearing the generated description has something to undo.
    expect(review?.canClear).toBe(true);
  });

  it('offers a suggestion only when the generated text differs from what is stored', () => {
    const review = descriptionReview(
      asset({ exifInfo: exif({ description: 'Grandma at the lake' }) }),
      enrichment({
        description: {
          status: Status.Success,
          appliedDescription: false,
          appliedTags: false,
          description: 'A lake at dusk',
        },
      }),
    );

    expect(review?.source).toBe('manual');
    expect(review?.suggestion).toBe('A lake at dusk');
    expect(review?.canAccept).toBe(true);
  });

  it('ignores whitespace-only differences so Accept is never a no-op', () => {
    const review = descriptionReview(
      asset({ exifInfo: exif({ description: '  A lake at dusk  ' }) }),
      enrichment({
        description: {
          status: Status.Success,
          appliedDescription: false,
          appliedTags: false,
          description: 'A lake at dusk',
        },
      }),
    );

    expect(review?.canAccept).toBe(false);
  });

  it('reports an empty description as none and carries the run error', () => {
    const review = descriptionReview(
      asset(),
      enrichment({
        description: { status: Status.Failed, appliedDescription: false, appliedTags: false, error: 'timeout' },
      }),
    );

    expect(review?.source).toBe('none');
    expect(review?.status).toBe(Status.Failed);
    expect(review?.error).toBe('timeout');
  });
});

describe('sensitivityReview', () => {
  it('is absent without an enrichment record', () => {
    expect(sensitivityReview(undefined)).toBeNull();
  });

  it('reports a run that never happened as not analysed', () => {
    const review = sensitivityReview(enrichment());

    expect(review?.state).toBe('missing');
    expect(review?.tone).toBe('neutral');
    expect(review?.scorePercent).toBeNull();
  });

  it('asks for review when the model flagged an asset nobody has decided on', () => {
    const review = sensitivityReview(
      enrichment({
        nsfwDetection: {
          status: Status2.Success,
          effectiveIsNsfw: true,
          isNsfw: true,
          score: 0.92,
          appliedTags: false,
        },
      }),
    );

    expect(review?.state).toBe('needs-review');
    expect(review?.tone).toBe('warning');
    expect(review?.scorePercent).toBe(92);
    expect(review?.marked).toBe(true);
  });

  it('reads a decision that contradicts the model as overridden', () => {
    const review = sensitivityReview(
      enrichment({
        nsfwDetection: {
          status: Status2.Success,
          effectiveIsNsfw: false,
          isNsfw: true,
          score: 0.88,
          appliedTags: false,
          review: { action: 'marked-safe', isNsfw: false, reviewedAt: '2026-09-22T00:00:00Z', reviewedBy: 'user-1' },
        } as AssetImageEnrichmentResponseDto['nsfwDetection'],
      }),
    );

    expect(review?.state).toBe('overridden');
    expect(review?.tone).toBe('blue');
    expect(review?.predicted).toBe(true);
    expect(review?.marked).toBe(false);
  });

  it('reads an accepted result as reviewed', () => {
    const review = sensitivityReview(
      enrichment({
        nsfwDetection: {
          status: Status2.Success,
          effectiveIsNsfw: true,
          isNsfw: true,
          score: 0.95,
          appliedTags: false,
          review: { action: 'accepted', isNsfw: true, reviewedAt: '2026-09-22T00:00:00Z', reviewedBy: 'user-1' },
        } as AssetImageEnrichmentResponseDto['nsfwDetection'],
      }),
    );

    expect(review?.state).toBe('reviewed');
    expect(review?.reviewed).toBe(true);
  });

  it('falls back to the score when the model reported no boolean', () => {
    const review = sensitivityReview(
      enrichment({
        nsfwDetection: { status: Status2.Success, effectiveIsNsfw: false, score: 0.7, appliedTags: false },
      }),
    );

    expect(review?.predicted).toBe(true);
    expect(review?.state).toBe('overridden');
  });

  it('clamps a score outside 0 to 1 instead of showing an impossible percentage', () => {
    const review = sensitivityReview(
      enrichment({
        nsfwDetection: {
          status: Status2.Success,
          effectiveIsNsfw: false,
          isNsfw: false,
          score: 1.4,
          appliedTags: false,
        },
      }),
    );

    expect(review?.scorePercent).toBe(100);
  });
});

describe('infoDetailRows', () => {
  it('keeps the path and the checksum away from anyone but the owner', () => {
    const ids = infoDetailRows(asset(), { isOwner: false }).map((row) => row.id);

    expect(ids).not.toContain('path');
    expect(ids).not.toContain('checksum');
    expect(ids).toContain('filename');
  });

  it('lists the design order for an owner', () => {
    const rows = infoDetailRows(
      asset({
        exifInfo: exif({
          exifImageWidth: 6000,
          exifImageHeight: 4000,
          fileSizeInByte: 12_300_000,
          make: 'Nikon',
          model: 'Z8',
          lensModel: '24-70mm',
          fNumber: 2.8,
          iso: 400,
        }),
      }),
      { isOwner: true },
    );

    expect(rows.map((row) => row.id)).toEqual(['filename', 'path', 'image', 'camera', 'lens', 'exposure', 'checksum']);
  });

  it('drops every row the asset cannot fill', () => {
    const rows = infoDetailRows(
      asset({ checksum: '', originalPath: '', exifInfo: undefined, width: null, height: null }),
      { isOwner: true },
    );

    expect(rows.map((row) => row.id)).toEqual(['filename']);
  });

  it('shows duration for a video and neither megapixels nor exposure', () => {
    const rows = infoDetailRows(
      asset({
        type: AssetTypeEnum.Video,
        duration: 95_000,
        exifInfo: exif({ exifImageWidth: 1920, exifImageHeight: 1080, fNumber: 2.8 }),
      }),
      { isOwner: true },
    );

    const ids = rows.map((row) => row.id);
    expect(ids).toContain('video');
    expect(ids).not.toContain('exposure');
    expect(rows.find((row) => row.id === 'video')?.value).toBe('1:35');
    expect(rows.find((row) => row.id === 'image')?.value).not.toContain('MP');
  });
});

describe('tagSuggestions (V-25)', () => {
  const tags = [
    { id: 't1', value: 'Trips' },
    { id: 't2', value: 'Trips/Rockies' },
    { id: 't3', value: 'Family' },
  ];

  it('offers the tags the item does not have, filtered by the typed text', () => {
    expect(tagSuggestions(tags, ['t1'], '').map((option) => option.id)).toEqual(['t2', 't3']);
    expect(tagSuggestions(tags, [], 'rock')).toEqual([
      { id: 't2', label: 'Trips/Rockies', create: false },
      { id: 'rock', label: 'rock', create: true },
    ]);
  });

  it('offers to create a tag the text does not name', () => {
    expect(tagSuggestions(tags, [], ' Hiking ').at(-1)).toEqual({ id: 'Hiking', label: 'Hiking', create: true });
    expect(tagSuggestions(tags, [], 'family').some((option) => option.create)).toBe(false);
  });

  it('caps the list at eight', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ id: `id${index}`, value: `Tag ${index}` }));
    expect(tagSuggestions(many, [], 'tag').filter((option) => !option.create)).toHaveLength(8);
  });
});

describe('ownerLine (V-27)', () => {
  const item = { ownerId: 'someone', owner: { name: 'Avery' } } as Parameters<typeof ownerLine>[0];

  it("names the owner of someone else's item, and nobody for one's own", () => {
    expect(ownerLine(item, 'me')).toEqual({ kind: 'owned', name: 'Avery' });
    expect(ownerLine(item, 'someone')).toBeNull();
    expect(ownerLine({ ownerId: 'someone' } as never, 'me')).toBeNull();
  });

  it('says who shared an item seen through a shared album', () => {
    expect(ownerLine(item, 'me', { sharedAlbum: true })).toEqual({ kind: 'shared', name: 'Avery' });
  });
});
