import { mergeProfiles } from 'src/services/person.service.js';

/** FL-1814: a merge carries how sure each date is together with the date it takes. */
describe(mergeProfiles.name, () => {
  const empty = { deathDate: null, notes: null };

  it('takes the date of passing with its precision when the survivor has none', () => {
    expect(
      mergeProfiles(null, empty, { deathDate: '2020-01-01', notes: null, deathDatePrecision: 'about' }),
    ).toMatchObject({ deathDate: '2020-01-01', deathDatePrecision: 'about' });
  });

  it("keeps the survivor's own date of passing and its precision", () => {
    expect(
      mergeProfiles(
        null,
        { deathDate: '2019-05-06', notes: null },
        { deathDate: '2020-01-01', notes: null, deathDatePrecision: 'year' },
      ),
    ).toBeUndefined();
  });

  it('takes the precision of a date of birth only when the date itself was taken', () => {
    const removed = { ...empty, birthDatePrecision: 'month' as const };
    expect(mergeProfiles('1987-03-01', empty, removed, true)).toEqual({ birthDatePrecision: 'month' });
    expect(mergeProfiles('1990-01-01', empty, removed, false)).toBeUndefined();
  });
});
