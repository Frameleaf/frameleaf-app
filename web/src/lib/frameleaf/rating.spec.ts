import { describe, expect, it } from 'vitest';
import { compareDecisionOf, compareRating } from '$lib/frameleaf/library-compare';
import { getExifRating } from '$lib/frameleaf/rating';

describe('EXIF rating compatibility', () => {
  it.each([
    [{ rating: null, isRejected: true }, -1],
    [{ rating: -1 }, -1],
    [{ rating: 4, isRejected: false }, 4],
    [{ rating: null, isRejected: false }, null],
    [undefined, null],
  ])('reads %j as %s', (exif, expected) => {
    expect(getExifRating(exif)).toBe(expected);
  });

  it('retains the compare reject decision and repeated-choice restore', () => {
    const rating = getExifRating({ rating: null, isRejected: true });
    expect(compareDecisionOf(rating)).toBe('reject');
    expect(compareRating('reject', rating)).toBeNull();
    expect(compareRating('keep', rating)).toBe(5);
  });
});
