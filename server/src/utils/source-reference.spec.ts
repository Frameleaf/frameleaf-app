import { sourceReferenceSchema } from 'src/utils/source-reference.js';

const reference = {
  resourceId: '00000000-0000-4000-8000-000000000001',
  version: 'a'.repeat(64),
  sha256: 'b'.repeat(64),
};
it('retains an exact source resource identity', () => {
  expect(sourceReferenceSchema.parse(reference)).toEqual(reference);
});
it.each([
  { ...reference, resourceId: 'another asset' },
  { ...reference, version: '' },
  { ...reference, sha256: 'B'.repeat(64) },
  { ...reference, cachePath: '/temporary/source.artifact' },
])('rejects malformed or extra source-reference authority: %j', (value) => {
  expect(sourceReferenceSchema.safeParse(value).success).toBe(false);
});
