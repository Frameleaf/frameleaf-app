import { randomUUID } from 'node:crypto';
import {
  desktopAccountPermitted,
  desktopAssistancePolicySchema,
  desktopAuthorityFor,
  desktopRevisionCurrent,
  householdDevices,
} from 'src/utils/desktop-assistance-policy.js';

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

describe('a computer that works on everyone’s photos (FL-1484)', () => {
  const taylor = '00000000-0000-4000-8000-000000000001';
  const emma = '00000000-0000-4000-8000-000000000002';
  const own = '00000000-0000-4000-8000-0000000000a1';
  const home = '00000000-0000-4000-8000-0000000000b1';
  const office = '00000000-0000-4000-8000-0000000000c1';
  const policy = (devices: string[]) => ({
    version: 1 as const,
    accounts: { [taylor]: { revisionId: own } },
    household: { revisionId: home, devices },
  });

  it("runs a photo's work under its owner's own approval first, then the household's", () => {
    expect(desktopAuthorityFor(policy([office]), taylor)).toEqual({ revisionId: own });
    expect(desktopAuthorityFor(policy([office]), emma)).toEqual({ revisionId: home });
    // no computer helps everyone: Emma's photos stay off the computers
    expect(desktopAuthorityFor(policy([]), emma)).toBeUndefined();
  });

  it('refuses work authorized under a household list that has changed or emptied', () => {
    expect(desktopRevisionCurrent(policy([office]), emma, home)).toBe(true);
    expect(desktopRevisionCurrent(policy([]), emma, home)).toBe(false);
    expect(desktopRevisionCurrent(policy([office]), emma, own)).toBe(false);
    expect(desktopRevisionCurrent(policy([]), taylor, own)).toBe(true);
    expect(householdDevices(policy([office]))).toEqual(new Set([office]));
  });
});
