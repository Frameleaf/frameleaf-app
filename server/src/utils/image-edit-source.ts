import { z } from 'zod';
import { sourceReferenceSchema } from 'src/utils/source-reference.js';

export const imageEditSourceSchema = z.union([
  sourceReferenceSchema,
  z.object({ kind: z.literal('unbound-reference') }).strict(),
]);
export type ImageEditSource = z.infer<typeof imageEditSourceSchema>;
