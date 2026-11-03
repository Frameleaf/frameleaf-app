import { parseImportedOwnerIntent } from 'src/library-import/owner-reconciliation.js';

const login = {
  revision: 'frozen',
  snapshotSha256: 'a'.repeat(64),
  accountEnabled: true,
  passwordLoginEnabled: true,
  secondFactorRequired: false,
  externalIdentityRequired: false,
  ownedLibraryAccess: 'full',
  otherRestrictions: 'none',
};
const restrictions = [
  { reason: 'account-disabled', change: { accountEnabled: false } },
  { reason: 'password-login-disabled', change: { passwordLoginEnabled: false } },
  { reason: 'second-factor-required', change: { secondFactorRequired: true } },
  { reason: 'external-identity-required', change: { externalIdentityRequired: true } },
  { reason: 'restricted-library-access', change: { ownedLibraryAccess: 'restricted' } },
  { reason: 'other-source-restrictions', change: { otherRestrictions: 'present' } },
];
const intent = (change: Record<string, unknown>, disposition: unknown) => ({
  sourceUserId: 'owner',
  email: 'OWNER@EXAMPLE.TEST',
  login: { ...login, ...change },
  disposition,
});
it.each(restrictions)('retains an explicitly acknowledged $reason owner', ({ reason, change }) => {
  expect(
    parseImportedOwnerIntent(
      intent(change, {
        kind: 'restricted',
        reasons: [reason],
        acknowledged: true,
        credential: 'preserve',
      }),
    ),
  ).toMatchObject({ email: 'owner@example.test', disposition: { kind: 'restricted', reasons: [reason] } });
});
it.each(restrictions)('does not activate or offer an ordinary claim for $reason', ({ change }) => {
  for (const disposition of [
    { kind: 'preserve' },
    { kind: 'claim', reason: 'no-local-verifier', claimPermitted: true },
  ])
    expect(() => parseImportedOwnerIntent(intent(change, disposition))).toThrow('OWNER_INTENT_INVALID');
});
it('requires complete matching restriction evidence and acknowledgement', () => {
  for (const disposition of [
    { kind: 'restricted', reasons: [], acknowledged: true, credential: 'preserve' },
    { kind: 'restricted', reasons: ['account-disabled'], acknowledged: false, credential: 'preserve' },
    { kind: 'restricted', reasons: ['second-factor-required'], acknowledged: true, credential: 'preserve' },
    {
      kind: 'restricted',
      reasons: ['account-disabled', 'account-disabled'],
      acknowledged: true,
      credential: 'preserve',
    },
    { kind: 'restricted', reasons: ['account-disabled'], acknowledged: true },
  ])
    expect(() => parseImportedOwnerIntent(intent({ accountEnabled: false }, disposition))).toThrow(
      'OWNER_INTENT_INVALID',
    );
  expect(() =>
    parseImportedOwnerIntent(
      intent(
        { accountEnabled: undefined },
        {
          kind: 'restricted',
          reasons: ['account-disabled'],
          acknowledged: true,
          credential: 'unavailable',
        },
      ),
    ),
  ).toThrow('OWNER_INTENT_INVALID');
});
it('does not invent a restriction for an unrestricted source owner', () => {
  expect(() =>
    parseImportedOwnerIntent(
      intent(
        {},
        {
          kind: 'restricted',
          reasons: ['account-disabled'],
          acknowledged: true,
          credential: 'unavailable',
        },
      ),
    ),
  ).toThrow('OWNER_INTENT_INVALID');
});
it('retains every known restriction without silently omitting another', () => {
  const change = { accountEnabled: false, secondFactorRequired: true };
  expect(
    parseImportedOwnerIntent(
      intent(change, {
        kind: 'restricted',
        reasons: ['account-disabled', 'second-factor-required'],
        acknowledged: true,
        credential: 'unavailable',
      }),
    ),
  ).toMatchObject({ disposition: { reasons: ['account-disabled', 'second-factor-required'] } });
  expect(() =>
    parseImportedOwnerIntent(
      intent(change, {
        kind: 'restricted',
        reasons: ['account-disabled'],
        acknowledged: true,
        credential: 'unavailable',
      }),
    ),
  ).toThrow('OWNER_INTENT_INVALID');
});
