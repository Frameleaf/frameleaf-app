import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const sourceReferenceSchema = z.object({ resourceId: z.uuid(), version: digest, sha256: digest }).strict();
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
