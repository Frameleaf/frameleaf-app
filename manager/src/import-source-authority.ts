import { z } from 'zod';
import { Refusal } from './contracts.js';
import { importHash, importSourceSchema } from './import-plan.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const sealSchema = z.strictObject({
  installation: z.string().regex(/^[a-f0-9]{12}$/u),
  binding: z.strictObject({
    operationId: uuid,
    manifestSha256: importHash,
    planSha256: importHash,
    source: importSourceSchema,
  }),
  destinationId: uuid,
});
const actionSchema = z.enum(['preflight', 'run', 'status', 'resume', 'verify', 'rollback', 'abandon']);
const requestFormat = 'frameleaf-import-source-authority-request';
const responseFormat = 'frameleaf-import-source-authority-response';
const requestSchema = sealSchema.extend({
  format: z.literal(requestFormat),
  version: z.literal(1),
  nonce: uuid,
  action: actionSchema,
});
const responseSchema = z.strictObject({
  format: z.literal(responseFormat),
  version: z.literal(1),
  nonce: uuid,
  allowed: z.literal(true),
});
export type ImportSourceAuthoritySeal = z.infer<typeof sealSchema>;
type Seal = ImportSourceAuthoritySeal;
export type ImportSourceAuthorityAction = z.infer<typeof actionSchema>;
export type ImportSourceAuthority = Seal & { verify: () => Promise<void> };
const authoritySchema = sealSchema.extend({
  verify: z.custom<() => Promise<void>>((value) => typeof value === 'function'),
});
export function parseImportSourceAuthority(input: unknown): ImportSourceAuthority {
  const parsed = authoritySchema.safeParse(input);
  if (!parsed.success) throw new Refusal('import_source_authority_invalid');
  return parsed.data;
}

export function encodeImportSourceAuthorityRequest(
  action: ImportSourceAuthorityAction,
  seal: Seal,
  nonce: string,
): string {
  const parsed = requestSchema.safeParse({
    installation: seal.installation,
    binding: seal.binding,
    destinationId: seal.destinationId,
    format: requestFormat,
    version: 1,
    nonce,
    action,
  });
  if (!parsed.success) throw new Refusal('import_source_authority_invalid');
  const { format, ...request } = parsed.data;
  return JSON.stringify({ format, ...request }) + '\n';
}

/** The caller owns the qualified review and live fencing; this protocol never supplies either. */
export async function replyImportSourceAuthority(
  line: string,
  action: ImportSourceAuthorityAction,
  authority?: ImportSourceAuthority,
): Promise<string | undefined> {
  if (!line.startsWith(`{"format":"${requestFormat}",`)) return undefined;
  if (!authority || typeof authority.verify !== 'function') throw new Refusal('import_source_authority_required');
  if (Buffer.byteLength(line) > 65536) throw new Refusal('import_source_authority_invalid');
  let input: unknown;
  try {
    input = JSON.parse(line);
  } catch {
    throw new Refusal('import_source_authority_invalid');
  }
  const request = requestSchema.safeParse(input);
  const expected = authoritySchema.safeParse(authority);
  if (
    !request.success ||
    !expected.success ||
    request.data.action !== action ||
    JSON.stringify({
      installation: request.data.installation,
      binding: request.data.binding,
      destinationId: request.data.destinationId,
    }) !==
      JSON.stringify({
        installation: expected.data.installation,
        binding: expected.data.binding,
        destinationId: expected.data.destinationId,
      })
  )
    throw new Refusal('import_source_authority_invalid');
  try {
    await expected.data.verify();
  } catch {
    throw new Refusal('import_source_authority_refused');
  }
  return JSON.stringify({ format: responseFormat, version: 1, nonce: request.data.nonce, allowed: true }) + '\n';
}

export function parseImportSourceAuthorityResponse(line: string, nonce: string): void {
  try {
    if (Buffer.byteLength(line) > 65536) throw new Error('Response too large');
    const parsed = responseSchema.safeParse(JSON.parse(line));
    if (parsed.success && parsed.data.nonce === nonce) return;
  } catch {
    /* Private protocol data never reaches logs. */
  }
  throw new Refusal('import_source_authority_unavailable');
}

const preparationFormat = 'frameleaf-import-preparation-authority-request';
const preparationSealSchema = z.strictObject({
  operationId: uuid,
  destinationId: uuid,
  source: importSourceSchema,
  preparationSha256: importHash,
});
const preparationRequestSchema = z.strictObject({
  format: z.literal(preparationFormat),
  version: z.literal(1),
  nonce: uuid,
  seal: preparationSealSchema,
});
export type ImportPreparationSeal = z.infer<typeof preparationSealSchema>;
export type ImportPreparationAuthority = ImportPreparationSeal & { verify: () => Promise<void> };

export function encodeImportPreparationRequest(seal: ImportPreparationSeal, nonce: string): string {
  const parsed = preparationRequestSchema.safeParse({ format: preparationFormat, version: 1, nonce, seal });
  if (!parsed.success) throw new Refusal('import_source_authority_invalid');
  return JSON.stringify(parsed.data) + '\n';
}

/** Preparation checks the frozen source and private request before a manifest or transfer plan exists. */
export async function replyImportPreparationAuthority(
  line: string,
  authority?: ImportPreparationAuthority,
): Promise<string | undefined> {
  if (!line.startsWith(`{"format":"${preparationFormat}",`)) return undefined;
  if (!authority || typeof authority.verify !== 'function') throw new Refusal('import_source_authority_required');
  if (Buffer.byteLength(line) > 65_536) throw new Refusal('import_source_authority_invalid');
  const { verify, ...seal } = authority;
  const expected = preparationSealSchema.safeParse(seal);
  let input: unknown;
  try {
    input = JSON.parse(line);
  } catch {
    throw new Refusal('import_source_authority_invalid');
  }
  const request = preparationRequestSchema.safeParse(input);
  if (!request.success || !expected.success || JSON.stringify(request.data.seal) !== JSON.stringify(expected.data))
    throw new Refusal('import_source_authority_invalid');
  try {
    await verify();
  } catch {
    throw new Refusal('import_source_authority_refused');
  }
  return JSON.stringify({ format: responseFormat, version: 1, nonce: request.data.nonce, allowed: true }) + '\n';
}
