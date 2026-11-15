import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { FACE_FOLDER_EXCLUSION_MAX_LENGTH } from 'src/utils/face-folder-exclusion.js';

// FL-934: folders whose photos an owner leaves out of face recognition
const FaceFolderPathSchema = z
  .string()
  .min(1)
  .max(FACE_FOLDER_EXCLUSION_MAX_LENGTH)
  .describe('Absolute folder path, as in the folders view (for example `/photos/scans`); a trailing `/` is optional');

const FaceFolderExclusionCreateSchema = z
  .object({ pathPrefix: FaceFolderPathSchema })
  .meta({ id: 'FaceFolderExclusionCreateDto' });

const FaceFolderExclusionPreviewQuerySchema = z
  .object({ pathPrefix: FaceFolderPathSchema })
  .meta({ id: 'FaceFolderExclusionPreviewQueryDto' });

const FaceFolderExclusionResponseSchema = z
  .object({
    id: z.uuidv4().describe('Exclusion ID'),
    pathPrefix: z.string().describe('The folder, as an absolute path ending in `/`'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When the folder was left out'),
  })
  .meta({ id: 'FaceFolderExclusionResponseDto' });

const FaceFolderExclusionCreateResponseSchema = FaceFolderExclusionResponseSchema.extend({
  removedFaceCount: z.int().min(0).describe('How many unconfirmed faces were removed from photos in the folder'),
}).meta({ id: 'FaceFolderExclusionCreateResponseDto' });

const FaceFolderExclusionPreviewSchema = z
  .object({
    pathPrefix: z.string().describe('The folder as it would be stored, an absolute path ending in `/`'),
    assetCount: z.int().min(0).describe('How many of your photos and videos are in the folder'),
    removableFaceCount: z
      .int()
      .min(0)
      .describe('How many faces would be removed: found automatically, never confirmed and not on a named person'),
    keptFaceCount: z
      .int()
      .min(0)
      .describe('How many faces would stay: added or confirmed by a person, or on a named person'),
  })
  .meta({ id: 'FaceFolderExclusionPreviewResponseDto' });

export class FaceFolderExclusionCreateDto extends createZodDto(FaceFolderExclusionCreateSchema) {}
export class FaceFolderExclusionPreviewQueryDto extends createZodDto(FaceFolderExclusionPreviewQuerySchema) {}
export class FaceFolderExclusionResponseDto extends createZodDto(FaceFolderExclusionResponseSchema) {}
export class FaceFolderExclusionCreateResponseDto extends createZodDto(FaceFolderExclusionCreateResponseSchema) {}
export class FaceFolderExclusionPreviewResponseDto extends createZodDto(FaceFolderExclusionPreviewSchema) {}
