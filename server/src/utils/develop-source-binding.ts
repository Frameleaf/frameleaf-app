import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from 'src/utils/object.js';
import { parseSourceOriginalPath } from 'src/utils/source-original.js';
import { sourceReferenceSchema } from 'src/utils/source-reference.js';

const original = z
  .object({
    assetId: z.uuid(),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes('\0')),
    checksum: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
    reference: sourceReferenceSchema.nullable(),
  })
  .strict()
  .refine(
    (value) => {
      try {
        return !!parseSourceOriginalPath(value.path) === (value.reference !== null);
      } catch {
        return false;
      }
    },
    { message: 'Develop original locator and reference disagree' },
  );

export const developSourceBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bound'), parent: original, input: original }).strict(),
  z.object({ kind: z.literal('unbound-reference') }).strict(),
]);
export type DevelopSourceBinding = z.infer<typeof developSourceBindingSchema>;

export const sameDevelopSourceBinding = (a: DevelopSourceBinding | null, b: DevelopSourceBinding | null) => {
  if (!a || !b) return a === b;
  if (a.kind !== 'bound' || b.kind !== 'bound') return false;
  const matches = (left: z.infer<typeof original>, right: z.infer<typeof original>) =>
    left.assetId === right.assetId &&
    left.checksum === right.checksum &&
    (left.reference
      ? left.path === right.path &&
        right.reference !== null &&
        left.reference.resourceId === right.reference.resourceId &&
        left.reference.version === right.reference.version &&
        left.reference.sha256 === right.reference.sha256
      : right.reference === null);
  return matches(a.parent, b.parent) && matches(a.input, b.input);
};

/** An optimistic version, never a source-read capability or a private locator. */
export const developSourceVersion = (binding: DevelopSourceBinding | null): string | undefined =>
  binding?.kind === 'bound' && (binding.parent.reference !== null || binding.input.reference !== null)
    ? createHash('sha256').update('frameleaf-develop-source/v1:').update(canonicalJson(binding)).digest('hex')
    : undefined;
