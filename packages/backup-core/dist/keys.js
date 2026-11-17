import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
export const FORMAT = 'frameleaf-repository';
export const VERSION = 1;
const NONCE = 12;
const TAG = 16;
export class UnsealError extends Error {
    name = 'UnsealError';
    constructor() {
        super('Could not open this data: the key is wrong or the data is damaged');
    }
}
export const derive = (key, salt, info, length = 32) => Buffer.from(hkdfSync('sha256', key, salt, `${FORMAT}/${VERSION} ${info}`, length));
export function deriveKeys(master, repoId) {
    if (master.length !== 32) {
        throw new RangeError('The repository key must be 32 bytes');
    }
    const salt = Buffer.from(repoId);
    return {
        id: derive(master, salt, 'id'),
        blob: derive(master, salt, 'blob'),
        cut: derive(master, salt, 'cut'),
        meta: derive(master, salt, 'meta'),
    };
}
export const blobId = (keys, plain) => createHmac('sha256', keys.id).update(plain).digest();
export function seal(key, aad, plain) {
    const nonce = randomBytes(NONCE);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}
export function unseal(key, aad, sealed) {
    if (sealed.length < NONCE + TAG) {
        throw new UnsealError();
    }
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE));
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
    try {
        return Buffer.concat([decipher.update(sealed.subarray(NONCE, sealed.length - TAG)), decipher.final()]);
    }
    catch {
        throw new UnsealError();
    }
}
export function sealBlob(keys, id, plain) {
    const packed = plain.length >= 64 ? zstdCompressSync(plain) : plain;
    const compressed = packed !== plain && packed.length <= plain.length - (plain.length >> 4);
    const flag = Buffer.from([compressed ? 1 : 0]);
    return Buffer.concat([
        flag,
        seal(derive(keys.blob, id, 'blob'), Buffer.concat([id, flag]), compressed ? packed : plain),
    ]);
}
export function openBlob(keys, id, blob) {
    const flag = blob.subarray(0, 1);
    if (flag[0] !== 0 && flag[0] !== 1) {
        throw new UnsealError();
    }
    const plain = unseal(derive(keys.blob, id, 'blob'), Buffer.concat([id, flag]), blob.subarray(1));
    return flag[0] === 1 ? zstdDecompressSync(plain) : plain;
}
