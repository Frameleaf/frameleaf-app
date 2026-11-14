import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** FL-1076: the only merge fields a contract template may use. */
export const CONTRACT_MERGE_FIELDS = ['client_name', 'session_date', 'total'] as const;
const sha256 = z.string().regex(/^[a-f\d]{64}$/);

export class PhotographyContractTemplateSaveDto extends createZodDto(
  z.object({
    name: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(50_000),
  }),
) {}
export class PhotographyContractTemplateDto extends createZodDto(
  PhotographyContractTemplateSaveDto.schema.extend({ id: z.uuidv4(), updatedAt: z.iso.datetime() }),
) {}
export class PhotographyContractTemplateListDto extends createZodDto(
  z.object({
    items: z.array(PhotographyContractTemplateDto.schema),
    fields: z.array(z.enum(CONTRACT_MERGE_FIELDS).meta({ id: 'PhotographyContractMergeField' })),
  }),
) {}

export class PhotographyContractCreateDto extends createZodDto(
  z.object({
    templateId: z.uuidv4(),
    clientName: z.string().trim().min(1).max(200),
    clientEmail: z.email().max(254),
    sessionDate: z.iso.date().optional(),
    total: z.string().trim().min(1).max(50).optional(),
  }),
) {}
const ContractStatus = z.enum(['draft', 'sent', 'viewed', 'signed', 'void']).meta({ id: 'PhotographyContractStatus' });
export class PhotographyContractDto extends createZodDto(
  z.object({
    id: z.uuidv4(),
    templateId: z.uuidv4().nullable(),
    name: z.string(),
    clientName: z.string(),
    clientEmail: z.string(),
    body: z.string(),
    documentSha256: sha256,
    status: ContractStatus,
    createdAt: z.iso.datetime(),
    sentAt: z.iso.datetime().nullable(),
    signedAt: z.iso.datetime().nullable(),
    signerName: z.string().nullable(),
    finalPdfSha256: sha256.nullable(),
  }),
) {}
export class PhotographyContractListDto extends createZodDto(
  z.object({ items: z.array(PhotographyContractDto.schema), mailReady: z.boolean() }),
) {}

const ContractEventType = z
  .enum(['created', 'sent', 'email_verified', 'viewed', 'consented', 'signed', 'finalized', 'voided'])
  .meta({ id: 'PhotographyContractEventType' });
export class PhotographyPublicContractDto extends createZodDto(
  z.object({
    studio: z.object({ name: z.string(), email: z.string(), color: z.string() }),
    name: z.string(),
    body: z.string(),
    documentSha256: sha256,
    signed: z.boolean(),
    signerName: z.string().nullable(),
    signedAt: z.iso.datetime().nullable(),
    history: z.array(z.object({ type: ContractEventType, at: z.iso.datetime() })),
  }),
) {}
export class PhotographyContractSignDto extends createZodDto(
  z.object({
    name: z.string().trim().min(1).max(200),
    signatureType: z.enum(['typed', 'drawn']).meta({ id: 'PhotographyContractSignatureType' }),
    signaturePng: z
      .string()
      .max(400_000)
      .regex(/^data:image\/png;base64,[A-Za-z\d+/]+=*$/)
      .optional()
      .describe('A PNG data URL; required for a drawn signature'),
    consent: z.literal(true),
    documentSha256: sha256.describe('The hash of the text the signer read'),
  }),
) {}
