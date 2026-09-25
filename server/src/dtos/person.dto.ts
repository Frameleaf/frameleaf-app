import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { ImageDimensions, MaybeDehydrated } from 'src/types.js';
import { AssetFace, Person } from 'src/database.js';
import { HistoryBuilder } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetEditActionItem } from 'src/dtos/editing.dto.js';
import { SourceTypeSchema } from 'src/enum.js';
import { asDateString, asDateTimeString } from 'src/utils/date.js';
import { transformFaceBoundingBox } from 'src/utils/transform.js';
import { hexColor, stringToBool } from 'src/validation.js';

const PersonCreateSchema = z
  .object({
    name: z.string().optional().describe('Person name'),
    birthDate: z
      .string()
      .meta({ format: 'date' })
      .nullable()
      .optional()
      .refine((val) => (val ? new Date(val) <= new Date() : true), { error: 'Birth date cannot be in the future' })
      .describe('Person date of birth'),
    isHidden: z.boolean().optional().describe('Person visibility (hidden)'),
    isFavorite: z.boolean().optional().describe('Mark as favorite'),
    color: hexColor.nullable().optional().describe('Person color (hex)'),
  })
  .meta({ id: 'PersonCreateDto' });

const PersonUpdateSchema = PersonCreateSchema.extend({
  featureFaceAssetId: z.uuidv4().optional().describe('Asset ID used for feature face thumbnail'),
}).meta({ id: 'PersonUpdateDto' });

const PeopleUpdateItemSchema = PersonUpdateSchema.extend({
  id: z.uuidv4().describe('Person ID'),
}).meta({ id: 'PeopleUpdateItem' });

const PeopleUpdateSchema = z
  .object({
    people: z.array(PeopleUpdateItemSchema).describe('People to update'),
  })
  .meta({ id: 'PeopleUpdateDto' });

const MergePersonSchema = z
  .object({
    ids: z.array(z.uuidv4()).describe('Person IDs to merge'),
  })
  .meta({ id: 'MergePersonDto' });

const PersonSearchSchema = z
  .object({
    withHidden: stringToBool.optional().describe('Include hidden people'),
    closestPersonId: z.uuidv4().optional().describe('Closest person ID for similarity search'),
    closestAssetId: z.uuidv4().optional().describe('Closest asset ID for similarity search'),
    page: z.coerce.number().int().min(1).default(1).describe('Page number for pagination'),
    size: z.coerce.number().int().min(1).max(1000).default(500).describe('Number of items per page'),
  })
  .meta({ id: 'PersonSearchDto' });

export const PersonResponseSchema = z
  .object({
    id: z.uuidv4().describe('Person ID'),
    name: z.string().describe('Person name'),
    // TODO: use `isoDateToDate` when using `ZodSerializerDto` on the controllers.
    birthDate: z.string().meta({ format: 'date' }).describe('Person date of birth').nullable(),
    thumbnailPath: z.string().describe('Thumbnail path'),
    isHidden: z.boolean().describe('Is hidden'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    updatedAt: z
      .string()
      .meta({ format: 'date-time' })
      .optional()
      .describe('Last update date')
      .meta(new HistoryBuilder().added('v1.107.0').stable('v2').getExtensions()),
    isFavorite: z
      .boolean()
      .optional()
      .describe('Is favorite')
      .meta(new HistoryBuilder().added('v1.126.0').stable('v2').getExtensions()),
    color: z
      .string()
      .optional()
      .describe('Person color (hex)')
      .meta(new HistoryBuilder().added('v1.126.0').stable('v2').getExtensions()),
  })
  .meta({ id: 'PersonResponseDto' });

export class PersonCreateDto extends createZodDto(PersonCreateSchema) {}
export class PersonUpdateDto extends createZodDto(PersonUpdateSchema) {}
export class PeopleUpdateDto extends createZodDto(PeopleUpdateSchema) {}
export class MergePersonDto extends createZodDto(MergePersonSchema) {}
export class PersonSearchDto extends createZodDto(PersonSearchSchema) {}
export class PersonResponseDto extends createZodDto(PersonResponseSchema) {}

// FL-57: a face shown as evidence: the photo (always one the viewer may see: their own, not trashed,
// not Locked, not hidden by their suppression rules) and where the face is in it, as fractions of the
// photo as it is displayed (after edits).
const FaceEvidenceSchema = z
  .object({
    assetId: z.uuidv4().describe('The complete photo the face is in'),
    faceId: z.uuidv4().nullable().describe('The face, when it still exists'),
    box: z
      .object({
        x: z.number().meta({ format: 'double' }).describe('Left edge, as a fraction of the photo width'),
        y: z.number().meta({ format: 'double' }).describe('Top edge, as a fraction of the photo height'),
        width: z.number().meta({ format: 'double' }).describe('Width, as a fraction of the photo width'),
        height: z.number().meta({ format: 'double' }).describe('Height, as a fraction of the photo height'),
      })
      .nullable()
      .describe('Where the face is in the photo'),
  })
  .meta({ id: 'FaceEvidenceDto' });

// FL-57: guided merge-suggestion verdict flow. `distance` is the face-embedding cosine
// distance between the two people's feature faces (lower means more similar); the client
// does not need to interpret it beyond ordering/labelling suggestions.
const PersonMergeSuggestionSchema = z
  .object({
    person: PersonResponseSchema.describe('The person being reviewed'),
    suggestion: PersonResponseSchema.describe('The suggested match for that person'),
    distance: z
      .number()
      .meta({ format: 'double' })
      .min(0)
      .describe('Face embedding distance between the two people (lower is more similar)'),
    personEvidence: FaceEvidenceSchema.nullable().describe(
      "The reviewed person's reference face and its complete photo, or null when none may be shown",
    ),
    suggestionEvidence: FaceEvidenceSchema.nullable().describe(
      "The suggested person's reference face and its complete photo, or null when none may be shown",
    ),
  })
  .meta({ id: 'PersonMergeSuggestionDto' });

const MergeSuggestionsResponseSchema = z
  .object({
    suggestions: z.array(PersonMergeSuggestionSchema).describe('Suggested pairs of people that may be the same person'),
  })
  .meta({ id: 'MergeSuggestionsResponseDto' });

const PersonMergeVerdictSchema = z
  .enum(['same', 'different', 'later', 'ignore'])
  .describe(
    '"same": merge the two people now (the named one survives, or `personId` when both or neither are named); ' +
      '"different": never suggest this pair again; "later": skip it for 30 days; ' +
      '"ignore": stop suggesting `personId` with anyone',
  )
  .meta({ id: 'PersonMergeVerdict' });

const PersonMergePairSchema = z.object({
  personId: z.uuidv4().describe('One person of the suggested pair (the reviewed person, for "ignore")'),
  suggestionId: z.uuidv4().describe('The other person of the suggested pair'),
});

const PersonMergeVerdictCreateSchema = PersonMergePairSchema.extend({
  verdict: PersonMergeVerdictSchema,
}).meta({ id: 'PersonMergeVerdictCreateDto' });

const PersonMergeVerdictDeleteSchema = PersonMergePairSchema.meta({ id: 'PersonMergeVerdictDeleteDto' });

const PersonMergeVerdictResponseSchema = z
  .object({
    personId: z
      .uuidv4()
      .describe(
        'The person of the pair whose id sorts first; the ignored person for "ignore"; the surviving person for "same"',
      ),
    suggestionId: z
      .uuidv4()
      .describe('The other person of the pair; the ignored person again for "ignore"; the merged person for "same"'),
    verdict: PersonMergeVerdictSchema,
    createdAt: z.string().meta({ format: 'date-time' }).describe('When the verdict was recorded'),
  })
  .meta({ id: 'PersonMergeVerdictResponseDto' });

export class FaceEvidenceDto extends createZodDto(FaceEvidenceSchema) {}
export class PersonMergeSuggestionDto extends createZodDto(PersonMergeSuggestionSchema) {}
export class PersonMergeVerdictCreateDto extends createZodDto(PersonMergeVerdictCreateSchema) {}
export class PersonMergeVerdictDeleteDto extends createZodDto(PersonMergeVerdictDeleteSchema) {}
export class PersonMergeVerdictResponseDto extends createZodDto(PersonMergeVerdictResponseSchema) {}
export class MergeSuggestionsResponseDto extends createZodDto(MergeSuggestionsResponseSchema) {}

// FL-57: correction history. Every manual face decision the owner made about this person (moving a
// face onto or off them, "not a face of anyone", a merge, a moved face box), kept in
// `immich_fork.face_correction` so it outlives face reprocessing.
const PersonCorrectionActionSchema = z
  .enum(['reassign', 'new-person', 'unassign', 'remove', 'merge', 'box-move'])
  .describe('What the decision did')
  .meta({ id: 'PersonCorrectionAction' });

const PersonCorrectionPersonSchema = z
  .object({
    id: z.uuidv4().describe('Person ID'),
    name: z.string().describe('The current name, or the name at the time when the person no longer exists'),
    exists: z.boolean().describe('Whether the person still exists'),
  })
  .meta({ id: 'PersonCorrectionPersonDto' });

const PersonCorrectionSchema = z
  .object({
    id: z.uuidv4().describe('Correction ID'),
    action: PersonCorrectionActionSchema,
    createdAt: z.string().meta({ format: 'date-time' }).describe('When the decision was made'),
    undoneAt: z.string().meta({ format: 'date-time' }).nullable().describe('When the decision was undone'),
    fromPerson: PersonCorrectionPersonSchema.nullable().describe('Who the face belonged to before'),
    toPerson: PersonCorrectionPersonSchema.nullable().describe('Who the face belongs to after'),
    evidence: FaceEvidenceSchema.nullable().describe('The photo and face, when it may still be shown'),
    evidenceRevoked: z
      .boolean()
      .describe('True when the decision was about a photo that can no longer be shown (trashed, Locked, hidden)'),
    undoable: z.boolean().describe('Whether this kind of decision can be undone and has not been'),
  })
  .meta({ id: 'PersonCorrectionDto' });

const PersonCorrectionsResponseSchema = z
  .object({
    corrections: z.array(PersonCorrectionSchema).describe('Manual face decisions for this person, most recent first'),
    hasNextPage: z.boolean().describe('Whether there are more pages'),
  })
  .meta({ id: 'PersonCorrectionsResponseDto' });

const PersonCorrectionSearchSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).describe('Page number'),
    size: z.coerce.number().int().min(1).max(100).default(25).describe('Number of decisions per page'),
  })
  .meta({ id: 'PersonCorrectionSearchDto' });

export class PersonCorrectionDto extends createZodDto(PersonCorrectionSchema) {}
export class PersonCorrectionsResponseDto extends createZodDto(PersonCorrectionsResponseSchema) {}
export class PersonCorrectionSearchDto extends createZodDto(PersonCorrectionSearchSchema) {}

export const AssetFaceResponseSchema = z
  .object({
    id: z.uuidv4().describe('Face ID'),
    imageHeight: z.int().min(0).describe('Image height in pixels'),
    imageWidth: z.int().min(0).describe('Image width in pixels'),
    boundingBoxX1: z.int().describe('Bounding box X1 coordinate'),
    boundingBoxX2: z.int().describe('Bounding box X2 coordinate'),
    boundingBoxY1: z.int().describe('Bounding box Y1 coordinate'),
    boundingBoxY2: z.int().describe('Bounding box Y2 coordinate'),
    sourceType: SourceTypeSchema.optional(),
    // FL-38: the face's revision and correction provenance, for revision-checked corrections.
    revision: z
      .string()
      .describe(
        'Changes whenever this face changes; send it back as expectedRevision so a correction made against an older face is refused with 409',
      )
      .meta(new HistoryBuilder().added('v3.2.1').getExtensions()),
    correctedAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When a person last corrected this face (moved, resized, reassigned or unassigned it), or null')
      .meta(new HistoryBuilder().added('v3.2.1').getExtensions()),
    hiddenAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When the owner hid this face, or null. Hidden faces are only listed with withHidden')
      .meta(new HistoryBuilder().added('v3.2.1').getExtensions()),
    person: PersonResponseSchema.nullable(),
  })
  .describe('Asset face with person')
  .meta({ id: 'AssetFaceResponseDto' });

export class AssetFaceResponseDto extends createZodDto(AssetFaceResponseSchema) {}

const AssetFaceUpdateItemSchema = z
  .object({
    personId: z.uuidv4().describe('Person ID'),
    assetId: z.uuidv4().describe('Asset ID'),
  })
  .meta({ id: 'AssetFaceUpdateItem' });

const AssetFaceUpdateSchema = z
  .object({
    data: z.array(AssetFaceUpdateItemSchema).describe('Face update items'),
  })
  .meta({ id: 'AssetFaceUpdateDto' });

const FaceSchema = z
  .object({
    id: z.uuidv4().describe('Face ID'),
  })
  .meta({ id: 'FaceDto' });

// FL-38: GET /faces keeps `id` (the asset) and may also list the faces its owner hid.
const FaceSearchSchema = FaceSchema.extend({
  withHidden: stringToBool
    .optional()
    .describe("Also list faces the asset's owner hid (owner only)")
    .meta(new HistoryBuilder().added('v3.2.1').getExtensions()),
}).meta({ id: 'FaceSearchDto' });

const expectedSourceRevision = z
  .string()
  .optional()
  .describe(
    'The face source revision (GET /faces/source) the coordinates were drawn on. When the image, its orientation or its edits changed since, the request is refused with 409',
  )
  .meta(new HistoryBuilder().added('v3.2.1').getExtensions());

const AssetFaceBoxSchema = z
  .object({
    imageWidth: z.int().min(1).describe('Width in pixels of the image the box was drawn on'),
    imageHeight: z.int().min(1).describe('Height in pixels of the image the box was drawn on'),
    x: z.int().min(0).describe('Face bounding box X coordinate'),
    y: z.int().min(0).describe('Face bounding box Y coordinate'),
    width: z.int().min(1).describe('Face bounding box width'),
    height: z.int().min(1).describe('Face bounding box height'),
  })
  .refine((box) => box.x + box.width <= box.imageWidth && box.y + box.height <= box.imageHeight, {
    error: 'The face box must lie inside the image',
  })
  .meta({ id: 'AssetFaceBoxDto' });

// FL-38: one revision-checked correction of an existing face (detected or manual).
const AssetFaceCorrectionSchema = z
  .object({
    expectedRevision: z
      .string()
      .describe('The face revision this correction was made against; a different current revision is refused with 409'),
    expectedPersonId: z
      .uuidv4()
      .nullable()
      .optional()
      .describe('The person the face was assigned to when the correction was made (null when unassigned)'),
    expectedSourceRevision,
    personId: z.uuidv4().nullable().optional().describe('Assign the face to this person, or null to unassign it'),
    box: AssetFaceBoxSchema.optional().describe('Move or resize the face, in the displayed (edited) image'),
    hidden: z.boolean().optional().describe('Hide the face, or show a hidden face again'),
  })
  .refine((dto) => dto.personId !== undefined || dto.box !== undefined || dto.hidden !== undefined, {
    error: 'Nothing to change',
  })
  .meta({ id: 'AssetFaceCorrectionDto' });

const AssetFaceSourceResponseSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID'),
    revision: z
      .string()
      .describe('Changes when the image, its orientation or its edits change; send it back as expectedSourceRevision'),
  })
  .meta({ id: 'AssetFaceSourceResponseDto' });

const AssetFaceCreateSchema = AssetFaceUpdateItemSchema.extend({
  imageWidth: z.int().describe('Image width in pixels'),
  imageHeight: z.int().describe('Image height in pixels'),
  x: z.int().describe('Face bounding box X coordinate'),
  y: z.int().describe('Face bounding box Y coordinate'),
  width: z.int().describe('Face bounding box width'),
  height: z.int().describe('Face bounding box height'),
  expectedSourceRevision,
}).meta({ id: 'AssetFaceCreateDto' });

const AssetFaceDeleteSchema = z
  .object({
    force: z.boolean().describe('Force delete even if person has other faces'),
    expectedRevision: z
      .string()
      .optional()
      .describe('The face revision the deletion was decided on; a different current revision is refused with 409')
      .meta(new HistoryBuilder().added('v3.2.1').getExtensions()),
  })
  .meta({ id: 'AssetFaceDeleteDto' });

const PersonStatisticsResponseSchema = z
  .object({
    assets: z.int().describe('Number of assets'),
    photos: z.int().describe('Number of photos among the assets'),
    videos: z.int().describe('Number of videos among the assets'),
  })
  .meta({ id: 'PersonStatisticsResponseDto' });

export class AssetFaceUpdateDto extends createZodDto(AssetFaceUpdateSchema) {}
export class FaceDto extends createZodDto(FaceSchema) {}
export class FaceSearchDto extends createZodDto(FaceSearchSchema) {}
export class AssetFaceBoxDto extends createZodDto(AssetFaceBoxSchema) {}
export class AssetFaceCorrectionDto extends createZodDto(AssetFaceCorrectionSchema) {}
export class AssetFaceSourceResponseDto extends createZodDto(AssetFaceSourceResponseSchema) {}
export class AssetFaceCreateDto extends createZodDto(AssetFaceCreateSchema) {}
export class AssetFaceDeleteDto extends createZodDto(AssetFaceDeleteSchema) {}
export class PersonStatisticsResponseDto extends createZodDto(PersonStatisticsResponseSchema) {}

// FL-37: the People grid's per-card "N items" and its Photo count / Recently seen sorts.
const PeopleListItemSchema = PersonResponseSchema.extend({
  assetCount: z.int().min(0).describe('Number of timeline assets showing this person'),
  lastSeenAt: z
    .string()
    .meta({ format: 'date-time' })
    .nullable()
    .describe('Capture date of the most recent timeline asset showing this person'),
}).meta({ id: 'PeopleListItemDto' });

const PeopleResponseSchema = z
  .object({
    total: z.int().min(0).describe('Total number of people'),
    hidden: z.int().min(0).describe('Number of hidden people'),
    people: z.array(PeopleListItemSchema),
    // TODO: make required after a few versions
    hasNextPage: z
      .boolean()
      .optional()
      .describe('Whether there are more pages')
      .meta(new HistoryBuilder().added('v1.110.0').stable('v2').getExtensions()),
  })
  .describe('People response');
export class PeopleResponseDto extends createZodDto(PeopleResponseSchema) {}

export function mapPerson(person: MaybeDehydrated<Person>): PersonResponseDto {
  return {
    id: person.personGroupId,
    name: person.name,
    birthDate: asDateString(person.birthDate),
    thumbnailPath: person.thumbnailPath,
    isHidden: person.isHidden,
    isFavorite: person.isFavorite,
    color: person.color ?? undefined,
    updatedAt: asDateTimeString(person.updatedAt),
  };
}

function mapFacesWithoutPerson(face: AssetFace, edits?: AssetEditActionItem[], assetDimensions?: ImageDimensions) {
  return {
    id: face.id,
    ...transformFaceBoundingBox(
      {
        boundingBoxX1: face.boundingBoxX1,
        boundingBoxY1: face.boundingBoxY1,
        boundingBoxX2: face.boundingBoxX2,
        boundingBoxY2: face.boundingBoxY2,
        imageWidth: face.imageWidth,
        imageHeight: face.imageHeight,
      },
      edits ?? [],
      assetDimensions ?? { width: face.imageWidth, height: face.imageHeight },
    ),
    sourceType: face.sourceType,
    revision: face.updateId,
    correctedAt: asDateTimeString(face.correctedAt ?? null) ?? null,
    hiddenAt: asDateTimeString(face.deletedAt) ?? null,
  };
}

export function mapFaces(
  face: AssetFace,
  auth: AuthDto,
  edits?: AssetEditActionItem[],
  assetDimensions?: ImageDimensions,
): AssetFaceResponseDto {
  return {
    ...mapFacesWithoutPerson(face, edits, assetDimensions),
    person: face.person ? mapPerson(face.person) : null,
  };
}
