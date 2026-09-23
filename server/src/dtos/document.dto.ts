import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto.js';
import {
  DocumentEditActionSchema,
  DocumentFieldSchema,
  DocumentFieldStatusSchema,
  DocumentLineStatusSchema,
} from 'src/enum.js';

/**
 * Document contracts (FL-63).
 *
 * A document is a photo with recognized text. The response keeps two things apart that a client
 * must never blur: what the text recognition read (`recognizedText`, `confidence`) and what the owner
 * decided (`status`, `text`, `value`). A suggested field value is `suggested`: read from the text,
 * checked by nobody, and shown with the region it came from.
 *
 * Every change names the revision it read. A change against a decision that moved on, or against
 * text that was read differently since, is refused with 409 and the client reloads.
 */

export const DOCUMENT_TEXT_MAX_LENGTH = 2000;
export const DOCUMENT_QUERY_MAX_LENGTH = 200;

const double = () => z.number().meta({ format: 'double' });

const DocumentRegionSchema = z
  .object({
    x1: double().describe('Normalized x coordinate of corner 1 (0-1)'),
    y1: double().describe('Normalized y coordinate of corner 1 (0-1)'),
    x2: double().describe('Normalized x coordinate of corner 2 (0-1)'),
    y2: double().describe('Normalized y coordinate of corner 2 (0-1)'),
    x3: double().describe('Normalized x coordinate of corner 3 (0-1)'),
    y3: double().describe('Normalized y coordinate of corner 3 (0-1)'),
    x4: double().describe('Normalized x coordinate of corner 4 (0-1)'),
    y4: double().describe('Normalized y coordinate of corner 4 (0-1)'),
  })
  .describe('Where the text is in the photo as it is shown, edits applied')
  .meta({ id: 'DocumentRegionDto' });

const DocumentLineSchema = z
  .object({
    id: z.string().describe('Recognized line ID, or the decision ID of a kept correction'),
    ocrId: z.uuidv4().nullable().describe('Recognized line ID; null once the line is gone'),
    editId: z.uuidv4().nullable().describe('ID of the owner’s decision about this line'),
    revision: z.int().nullable().describe('Revision of the owner’s decision'),
    status: DocumentLineStatusSchema,
    text: z.string().describe('What the line reads: the owner’s correction or the recognized text'),
    recognizedText: z.string().nullable().describe('The recognized text, while the recognized line exists'),
    confidence: double().nullable().describe('Recognition confidence (0-1)'),
    region: DocumentRegionSchema.nullable(),
    evidenceChanged: z.boolean().describe('The decision was made against text that has since been read differently'),
  })
  .meta({ id: 'DocumentLineDto' });

const DocumentFieldCandidateSchema = z
  .object({
    value: z.string().describe('The value as the text reads it'),
    lineId: z.uuidv4().describe('Recognized line the value was read from'),
    confidence: double().nullable().describe('Recognition confidence of that line; null for a corrected line'),
    region: DocumentRegionSchema,
  })
  .meta({ id: 'DocumentFieldCandidateDto' });

const DocumentFieldResponseSchema = z
  .object({
    field: DocumentFieldSchema,
    status: DocumentFieldStatusSchema,
    value: z.string().nullable().describe('The suggested, confirmed or corrected value; null when dismissed'),
    confidence: double().nullable().describe('Recognition confidence of the supporting line (0-1)'),
    lineId: z.uuidv4().nullable().describe('Recognized line supporting the value'),
    region: DocumentRegionSchema.nullable(),
    evidenceChanged: z.boolean().describe('The supporting text has since been read differently or is gone'),
    candidates: z.array(DocumentFieldCandidateSchema).describe('Values the text suggests, most likely first'),
    editId: z.uuidv4().nullable().describe('ID of the owner’s decision about this field'),
    revision: z.int().nullable().describe('Revision of the owner’s decision'),
    updatedAt: z.string().meta({ format: 'date-time' }).nullable().describe('When the owner last decided'),
  })
  .meta({ id: 'DocumentFieldResponseDto' });

const DocumentRecognitionSchema = z
  .object({
    enabled: z.boolean().describe('Text recognition is switched on'),
    routed: z.boolean().describe('A processing destination is chosen for text recognition'),
  })
  .meta({ id: 'DocumentRecognitionDto' });

const DocumentResponseSchema = z
  .object({
    assetId: z.uuidv4(),
    canEdit: z.boolean().describe('The caller owns the photo and may correct its text'),
    recognizedAt: z.string().meta({ format: 'date-time' }).nullable().describe('When the text was last read'),
    lines: z.array(DocumentLineSchema),
    fieldsEnabled: z.boolean().describe('Field suggestions are switched on'),
    fields: z.array(DocumentFieldResponseSchema),
    recognition: DocumentRecognitionSchema.nullable().describe('Whether the photo can be read again; owner only'),
  })
  .meta({ id: 'DocumentResponseDto' });

const DocumentSearchSchema = z
  .object({
    query: z
      .string()
      .trim()
      .max(DOCUMENT_QUERY_MAX_LENGTH)
      .optional()
      .describe('Text to find in recognized text and in the owner’s corrections'),
    page: z.coerce.number().int().min(1).default(1),
    size: z.coerce.number().int().min(1).max(250).default(100),
  })
  .meta({ id: 'DocumentSearchDto' });

const DocumentSearchResponseSchema = z
  .object({
    total: z.int().min(0),
    items: z.array(AssetResponseSchema),
    nextPage: z.string().nullable(),
  })
  .meta({ id: 'DocumentSearchResponseDto' });

const documentText = () => z.string().trim().min(1).max(DOCUMENT_TEXT_MAX_LENGTH);

const DocumentLineEditSchema = z
  .object({
    ocrId: z.uuidv4().describe('Recognized line the decision is about'),
    recognizedText: z.string().describe('The recognized text the caller read; refused when it changed'),
    action: DocumentEditActionSchema,
    value: documentText().optional().describe('The corrected text, for correct'),
    revision: z.int().min(1).nullable().optional().describe('Revision of the existing decision, if there is one'),
  })
  .meta({ id: 'DocumentLineEditDto' });

const DocumentFieldEditSchema = z
  .object({
    action: DocumentEditActionSchema,
    value: documentText().optional().describe('The value, for confirm and correct'),
    lineId: z.uuidv4().nullable().optional().describe('Recognized line supporting the value'),
    recognizedText: z.string().optional().describe('The recognized text of that line the caller read'),
    revision: z.int().min(1).nullable().optional().describe('Revision of the existing decision, if there is one'),
  })
  .meta({ id: 'DocumentFieldEditDto' });

const DocumentRevisionSchema = z
  .object({
    revision: z.coerce.number().int().min(1).describe('Revision of the decision being removed'),
  })
  .meta({ id: 'DocumentRevisionDto' });

const DocumentLineParamSchema = z.object({
  id: z.uuidv4(),
  editId: z.uuidv4(),
});

const DocumentFieldParamSchema = z.object({
  id: z.uuidv4(),
  field: DocumentFieldSchema,
});

export class DocumentRegionDto extends createZodDto(DocumentRegionSchema) {}
export class DocumentLineDto extends createZodDto(DocumentLineSchema) {}
export class DocumentFieldResponseDto extends createZodDto(DocumentFieldResponseSchema) {}
export class DocumentResponseDto extends createZodDto(DocumentResponseSchema) {}
export class DocumentSearchDto extends createZodDto(DocumentSearchSchema) {}
export class DocumentSearchResponseDto extends createZodDto(DocumentSearchResponseSchema) {}
export class DocumentLineEditDto extends createZodDto(DocumentLineEditSchema) {}
export class DocumentFieldEditDto extends createZodDto(DocumentFieldEditSchema) {}
export class DocumentRevisionDto extends createZodDto(DocumentRevisionSchema) {}
export class DocumentLineParamDto extends createZodDto(DocumentLineParamSchema) {}
export class DocumentFieldParamDto extends createZodDto(DocumentFieldParamSchema) {}
