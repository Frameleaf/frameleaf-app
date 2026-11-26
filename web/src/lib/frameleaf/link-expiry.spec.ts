import {
  LINK_EXPIRY_NONE,
  effectiveLinkExpiryDays,
  linkExpiryChoices,
  linkExpiryFromValue,
  linkExpiryValue,
} from '$lib/frameleaf/link-expiry';

/** FL-922: the default expiry of new shared links. */
describe('link-expiry', () => {
  it('uses the person’s own default, else the server’s, else none', () => {
    expect(effectiveLinkExpiryDays(7, 30)).toBe(7);
    expect(effectiveLinkExpiryDays(null, 30)).toBe(30);
    expect(effectiveLinkExpiryDays(undefined, null)).toBeNull();
  });

  it('turns a select value into days and back', () => {
    expect(linkExpiryFromValue(LINK_EXPIRY_NONE)).toBeNull();
    expect(linkExpiryFromValue('30')).toBe(30);
    expect(linkExpiryValue(null)).toBe(LINK_EXPIRY_NONE);
    expect(linkExpiryValue(90)).toBe('90');
  });

  it('keeps a stored value the list does not offer, in order', () => {
    expect(linkExpiryChoices(null)).toEqual([1, 7, 30, 90, 365]);
    expect(linkExpiryChoices(30)).toEqual([1, 7, 30, 90, 365]);
    expect(linkExpiryChoices(14)).toEqual([1, 7, 14, 30, 90, 365]);
  });
});
