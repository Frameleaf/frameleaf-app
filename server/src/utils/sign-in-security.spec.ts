import { describe, expect, it } from 'vitest';
import { signInNetwork } from 'src/utils/sign-in-security.js';

describe(signInNetwork.name, () => {
  it.each([
    ['192.0.2.199', '192.0.2.0/24'],
    ['::ffff:192.0.2.199', '192.0.2.0/24'],
    ['2001:db8:123:456::ffff', '2001:0db8:0123::/48'],
    ['invalid', null],
  ])('reduces %s to %s', (address, expected) => expect(signInNetwork(address)).toBe(expected));
});
