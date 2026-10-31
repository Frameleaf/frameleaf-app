import { sharedFirstName } from '$lib/frameleaf/merge-suggestion';

describe('sharedFirstName (FL-83 PG-10)', () => {
  it('gives the first name both people carry, ignoring case', () => {
    expect(sharedFirstName('Alice Park', 'alice')).toBe('Alice');
  });

  it('gives nothing when the first names differ or a person is unnamed', () => {
    expect(sharedFirstName('Alice', 'Alicia')).toBeUndefined();
    expect(sharedFirstName('', 'Alice')).toBeUndefined();
    expect(sharedFirstName('Alice', undefined)).toBeUndefined();
  });
});
