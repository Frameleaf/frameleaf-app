import { randomBytes } from 'node:crypto';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PREFIX = 'FLRK';
const RAW_LENGTH = 20;
const ENCODED_LENGTH = (RAW_LENGTH * 8) / 5;
const encode = (bytes) => {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    return out;
};
export function generateRecoveryKey() {
    const groups = encode(randomBytes(RAW_LENGTH)).match(/.{4}/g);
    return [PREFIX, ...groups].join('-');
}
export function parseRecoveryKey(text) {
    let compact = text.toUpperCase().replaceAll(/[\s-]/g, '');
    if (compact.length === PREFIX.length + ENCODED_LENGTH && compact.startsWith(PREFIX)) {
        compact = compact.slice(PREFIX.length);
    }
    if (compact.length !== ENCODED_LENGTH)
        throw new Error('A recovery key has 32 characters after FLRK');
    const out = Buffer.alloc(RAW_LENGTH);
    let bits = 0;
    let value = 0;
    let index = 0;
    for (const char of compact) {
        const digit = ALPHABET.indexOf(char);
        if (digit === -1)
            throw new Error('A recovery key uses only the letters A-Z and the digits 2-7');
        value = ((value << 5) | digit) & 0xff_ff;
        bits += 5;
        if (bits >= 8) {
            out[index++] = (value >>> (bits - 8)) & 0xff;
            bits -= 8;
        }
    }
    return out;
}
