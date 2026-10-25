import {
  developSourceBindingSchema,
  developSourceVersion,
  sameDevelopSourceBinding,
} from 'src/utils/develop-source-binding.js';

const id = '10000000-0000-4000-8000-000000000001';
const snapshot = {
  assetId: id,
  path: `frameleaf-source://${id}/${'b'.repeat(64)}`,
  checksum: 'c'.repeat(40),
  reference: { resourceId: id, version: 'd'.repeat(64), sha256: 'e'.repeat(64) },
};
const binding = { kind: 'bound' as const, parent: snapshot, input: snapshot };
it('retains both exact source snapshots and refuses unbound history as an active binding', () => {
  expect(sameDevelopSourceBinding(developSourceBindingSchema.parse(binding), binding)).toBe(true);
  expect(sameDevelopSourceBinding({ kind: 'unbound-reference' }, { kind: 'unbound-reference' })).toBe(false);
  expect(
    sameDevelopSourceBinding(binding, {
      ...binding,
      input: { ...snapshot, reference: { ...snapshot.reference, version: 'f'.repeat(64) } },
    }),
  ).toBe(false);
});

it('rejects extra cache authority and unbound source locators', () => {
  expect(
    developSourceBindingSchema.safeParse({ ...binding, input: { ...snapshot, localPath: '/private/cache' } }).success,
  ).toBe(false);
  expect(developSourceBindingSchema.safeParse({ ...binding, parent: { ...snapshot, reference: null } }).success).toBe(
    false,
  );
});

it('uses a stable opaque fingerprint for source snapshots and changes it with the selected resource', () => {
  const version = developSourceVersion(binding);
  expect(version).toMatch(/^[a-f0-9]{64}$/u);
  expect(developSourceVersion({ input: snapshot, parent: snapshot, kind: 'bound' })).toBe(version);
  expect(
    developSourceVersion({
      ...binding,
      input: { ...snapshot, reference: { ...snapshot.reference, version: 'f'.repeat(64) } },
    }),
  ).not.toBe(version);
  expect(developSourceVersion(null)).toBeUndefined();
  expect(developSourceVersion({ kind: 'unbound-reference' })).toBeUndefined();
});
