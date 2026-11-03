import { isBelowRoot, railMoreStep, railSectionsBelow } from '$lib/frameleaf/rail-more';

describe('railSectionsBelow (FL-707 B2)', () => {
  const headings = [
    { label: 'Explore', below: false },
    { label: 'Albums', below: false },
    { label: 'Shared spaces', below: true },
    { label: 'Tools', below: true },
  ];

  it('names the sections whose headings are out of sight', () => {
    expect(railSectionsBelow(false, headings)).toEqual(['Shared spaces', 'Tools']);
  });

  it('still says there is more when only rows are hidden', () => {
    expect(railSectionsBelow(false, [{ label: 'Explore', below: false }])).toEqual(['']);
  });

  it('skips the unlabelled divider headings of the collapsed rail', () => {
    expect(railSectionsBelow(false, [{ label: '', below: true }])).toEqual(['']);
  });

  it('goes away at the end of the list, and when nothing scrolls', () => {
    expect(railSectionsBelow(true, headings)).toEqual([]);
    expect(railSectionsBelow(true, [])).toEqual([]);
  });

  it('scrolls most of a screen per press', () => {
    expect(railMoreStep(500)).toBe(400);
  });
});

describe('isBelowRoot', () => {
  const rootBounds = { top: 100, bottom: 600 } as DOMRectReadOnly;
  const at = (top: number, isIntersecting = false) => ({
    isIntersecting,
    boundingClientRect: { top } as DOMRectReadOnly,
    rootBounds,
  });

  it('is true for a hidden heading past the bottom edge', () => {
    expect(isBelowRoot(at(650))).toBe(true);
  });

  it('is false for a heading scrolled away above, or one in sight', () => {
    expect(isBelowRoot(at(40))).toBe(false);
    expect(isBelowRoot(at(300, true))).toBe(false);
  });
});
