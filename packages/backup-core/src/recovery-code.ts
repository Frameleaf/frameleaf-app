// Crockford base32: no I, L, O or U, so a written-down code is hard to misread.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'FLRK';

/** A 256-bit key as the code a recovery kit prints: `FLRK-XXXX-…` (52 symbols in 13 groups). */
export function recoveryCode(key: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }
  return [PREFIX, ...(output.match(/.{1,4}/g) ?? [])].join('-');
}

/**
 * The key a recovery code stands for, or null when the code is not complete. Spaces, dashes and case
 * are ignored, and the letters people misread are taken for the digits they look like (O for 0, I and L for 1).
 */
export function parseRecoveryCode(code: string): Buffer | null {
  const symbols = code
    .toUpperCase()
    .replaceAll(/[\s-]/g, '')
    .replace(/^FLRK/, '')
    .replaceAll('O', '0')
    .replaceAll(/[IL]/g, '1');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const symbol of symbols) {
    const index = ALPHABET.indexOf(symbol);
    if (index === -1) {
      return null;
    }
    value = ((value << 5) | index) & 0xff_ff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.length === 32 ? Buffer.from(bytes) : null;
}
