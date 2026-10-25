import {
  healthSourceTrashIntentSchema,
  sameHealthSourceReview,
  sameHealthSourceTrashIntent,
} from 'src/utils/media-health.js';

const source = { resourceId: '12345678-1234-4234-8234-123456789012', version: 'a'.repeat(64), sha256: 'b'.repeat(64) };
const intent = {
  ownerId: '12345678-1234-4234-8234-123456789013',
  confirmationId: '12345678-1234-4234-8234-123456789014',
  source,
};

it('recognizes the exact reviewed resource and submitted confirmation', () => {
  expect(sameHealthSourceReview(source, structuredClone(source))).toBe(true);
  expect(sameHealthSourceTrashIntent(intent, structuredClone(intent))).toBe(true);
});
it.each(['resourceId', 'version', 'sha256'] as const)('refuses a different reviewed %s', (field) => {
  const changed = {
    ...source,
    [field]: field === 'resourceId' ? '12345678-1234-4234-8234-123456789015' : 'c'.repeat(64),
  };
  expect(sameHealthSourceReview(source, changed)).toBe(false);
  expect(sameHealthSourceTrashIntent(intent, { ...intent, source: changed })).toBe(false);
});
it.each(['ownerId', 'confirmationId'] as const)('refuses a different confirmation %s', (field) => {
  expect(sameHealthSourceTrashIntent(intent, { ...intent, [field]: '12345678-1234-4234-8234-123456789015' })).toBe(
    false,
  );
});
it('rejects unreviewed authority fields and malformed historical evidence', () => {
  expect(healthSourceTrashIntentSchema.safeParse({ ...intent, path: '/provider/original.jpg' }).success).toBe(false);
  expect(
    healthSourceTrashIntentSchema.safeParse({ ...intent, source: { ...source, path: '/provider/original.jpg' } })
      .success,
  ).toBe(false);
  expect(sameHealthSourceTrashIntent(intent, undefined)).toBe(false);
  expect(sameHealthSourceReview(source, { resourceId: source.resourceId })).toBe(false);
});
