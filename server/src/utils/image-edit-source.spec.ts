import { imageEditSourceSchema } from 'src/utils/image-edit-source.js';

const reference = {
  resourceId: '018e50c9-910e-4ef7-b38e-2ca6e8801667',
  version: 'a'.repeat(64),
  sha256: 'b'.repeat(64),
};
it('retains the exact saved resource identity', () => {
  expect(imageEditSourceSchema.parse(reference)).toEqual(reference);
  expect(imageEditSourceSchema.safeParse({ ...reference, future: true }).success).toBe(false);
  expect(imageEditSourceSchema.safeParse({ ...reference, version: 'unknown' }).success).toBe(false);
});
it('retains an explicitly unbound historical recipe without guessing current bytes', () => {
  expect(imageEditSourceSchema.parse({ kind: 'unbound-reference' })).toEqual({ kind: 'unbound-reference' });
  expect(imageEditSourceSchema.safeParse({ kind: 'unbound-reference', ...reference }).success).toBe(false);
});
