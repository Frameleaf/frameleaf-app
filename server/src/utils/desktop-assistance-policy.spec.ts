import { randomUUID } from 'node:crypto';
import { desktopAccountPermitted, desktopAssistancePolicySchema } from 'src/utils/desktop-assistance-policy.js';

it('never turns automatic administrator consent into permission for a demoted member', () => {
  const id = randomUUID();
  const policy = desktopAssistancePolicySchema.parse({ version: 1, accounts: { [id]: { revisionId: randomUUID() } } });
  expect(desktopAccountPermitted(policy, id, true)).toBe(true);
  expect(desktopAccountPermitted(policy, id, false)).toBe(false);
  expect(desktopAccountPermitted(policy, randomUUID(), true)).toBe(false);
  policy.accounts[id].memberApproved = true;
  expect(desktopAccountPermitted(policy, id, false)).toBe(true);
});

it('refuses malformed member approval and unrelated or missing account policy', () => {
  const id = randomUUID();
  expect(
    desktopAssistancePolicySchema.safeParse({
      version: 1,
      accounts: { [id]: { revisionId: randomUUID(), memberApproved: 'true' } },
    }).success,
  ).toBe(false);
  expect(desktopAccountPermitted({ version: 1, accounts: {} }, id, false)).toBe(false);
});
