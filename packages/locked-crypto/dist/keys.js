import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scrypt, timingSafeEqual, } from 'node:crypto';
import { promisify } from 'node:util';
import { publicKeyFromPrivate, WrongSecretError } from './format.js';
import { parseRecoveryKey } from './recovery.js';
export const KEY_FILE_FORMAT_1 = 'frameleaf-locked-key/1';
export const KEY_FILE_FORMAT_2 = 'frameleaf-locked-key/2';
export const KEY_FILE_FORMATS = [KEY_FILE_FORMAT_1, KEY_FILE_FORMAT_2];
export const isKeyFileFormat = (format) => typeof format === 'string' &&
    KEY_FILE_FORMATS.includes(format);
const SCRYPT = { N: 131_072, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const SALT = 16;
const NONCE = 12;
const KEY = 32;
const TAG = 16;
export const PEPPER_BYTES = 32;
const MIN_PEPPER_BYTES = 16;
const PEPPER_INFO = 'frameleaf-locked/2/pin-wrap-pepper';
export class LockedKeyFileCorruptError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LockedKeyFileCorruptError';
    }
}
export class LockedPepperError extends Error {
    reason;
    constructor(message, reason) {
        super(message);
        this.reason = reason;
        this.name = 'LockedPepperError';
    }
}
const scryptAsync = promisify(scrypt);
export const pepperId = (pepper) => createHash('sha256')
    .update(PEPPER_INFO)
    .update(pepper)
    .digest()
    .subarray(0, 8)
    .toString('base64');
const assertPepper = (pepper) => {
    if (!Buffer.isBuffer(pepper) || pepper.length < MIN_PEPPER_BYTES) {
        throw new Error(`The pepper must be at least ${MIN_PEPPER_BYTES} bytes`);
    }
};
const aad = (file, kind, pepper) => Buffer.from(pepper
    ? `${KEY_FILE_FORMAT_2}|${file.userId}|${kind}|pepper:${pepper.id}`
    : `${KEY_FILE_FORMAT_1}|${file.userId}|${kind}`, 'utf8');
const assertFormat = (file) => {
    if (!isKeyFileFormat(file.format))
        throw new Error(`Unsupported key file format ${String(file.format)}`);
};
const base64Length = (value) => typeof value === 'string' ? Buffer.from(value, 'base64').length : -1;
const assertWrap = (wrap) => {
    const corrupt = (what) => new LockedKeyFileCorruptError(`The key file's ${wrap.kind} wrap ${what}`);
    if (wrap.kdf === 'scrypt') {
        if (wrap.N !== SCRYPT.N || wrap.r !== SCRYPT.r || wrap.p !== SCRYPT.p) {
            throw corrupt(`has scrypt parameters other than N=${SCRYPT.N} r=${SCRYPT.r} p=${SCRYPT.p}`);
        }
    }
    else if (wrap.kdf !== 'hkdf-sha256') {
        throw corrupt(`uses an unknown key derivation ${String(wrap.kdf)}`);
    }
    if (base64Length(wrap.salt) !== SALT)
        throw corrupt(`has a salt that is not ${SALT} bytes`);
    if (base64Length(wrap.nonce) !== NONCE)
        throw corrupt(`has a nonce that is not ${NONCE} bytes`);
    if (base64Length(wrap.ciphertext) !== KEY + TAG)
        throw corrupt(`has a ciphertext that is not ${KEY + TAG} bytes`);
    if (wrap.pepper !== undefined) {
        if (wrap.kind !== 'pin')
            throw corrupt('is peppered, which only a PIN wrap can be');
        if (wrap.pepper?.kdf !== 'hkdf-sha256' ||
            base64Length(wrap.pepper.id) !== 8) {
            throw corrupt('has an unreadable pepper record');
        }
    }
};
const normalize = (secret) => secret.normalize('NFKC');
const deriveWrapKey = async (wrap, secret, pepper) => {
    const salt = Buffer.from(wrap.salt, 'base64');
    if (wrap.kdf === 'hkdf-sha256') {
        let raw;
        try {
            raw = parseRecoveryKey(secret);
        }
        catch {
            throw new WrongSecretError('That is not a valid recovery key');
        }
        return Buffer.from(hkdfSync('sha256', raw, salt, 'frameleaf-locked/1/recovery-wrap', KEY));
    }
    if (!wrap.pepper) {
        return scryptAsync(normalize(secret), salt, KEY, {
            ...SCRYPT,
            maxmem: SCRYPT_MAXMEM,
        });
    }
    if (!pepper) {
        throw new LockedPepperError(`This key file's ${wrap.kind} wrap needs the server's Locked pepper`, 'missing');
    }
    assertPepper(pepper);
    if (pepperId(pepper) !== wrap.pepper.id) {
        throw new LockedPepperError(`The Locked pepper supplied is not the one this key file's ${wrap.kind} wrap was made with`, 'mismatch');
    }
    const stretched = await scryptAsync(normalize(secret), salt, KEY, {
        ...SCRYPT,
        maxmem: SCRYPT_MAXMEM,
    });
    try {
        return Buffer.from(hkdfSync('sha256', stretched, pepper, PEPPER_INFO, KEY));
    }
    finally {
        stretched.fill(0);
    }
};
const touch = (file) => ({
    ...file,
    updatedAt: new Date().toISOString(),
});
export async function wrapKey(file, privateKey, kind, secret, options = {}) {
    assertFormat(file);
    if (!publicKeyFromPrivate(privateKey).equals(Buffer.from(file.publicKey, 'base64'))) {
        throw new Error('The private key does not match the key file');
    }
    if (kind === 'pin' && file.mode === 'advanced')
        throw new Error('An advanced key file never holds a PIN wrap');
    if (secret.length === 0)
        throw new Error('The secret is empty');
    const pepper = kind === 'pin' ? options.pepper : undefined;
    if (pepper)
        assertPepper(pepper);
    const salt = randomBytes(SALT).toString('base64');
    const params = kind === 'recovery'
        ? { kdf: 'hkdf-sha256' }
        : { kdf: 'scrypt', ...SCRYPT };
    const pepperRecord = pepper
        ? { kdf: 'hkdf-sha256', id: pepperId(pepper) }
        : undefined;
    const key = await deriveWrapKey({ kind, salt, ...params, pepper: pepperRecord }, secret, pepper);
    const nonce = randomBytes(NONCE);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(file, kind, pepperRecord));
    const ciphertext = Buffer.concat([
        cipher.update(privateKey),
        cipher.final(),
        cipher.getAuthTag(),
    ]);
    key.fill(0);
    const wrap = {
        kind,
        ...params,
        salt,
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        ...(pepperRecord && { pepper: pepperRecord }),
    };
    const wraps = [
        ...(file.wraps ?? []).filter((existing) => existing.kind !== kind),
        wrap,
    ];
    const format = wraps.some((candidate) => candidate.pepper)
        ? KEY_FILE_FORMAT_2
        : file.format;
    return touch({ ...file, format, wraps });
}
export async function unwrapKey(file, kind, secret, options = {}) {
    assertFormat(file);
    const wrap = file.wraps.find((candidate) => candidate.kind === kind);
    if (!wrap)
        throw new WrongSecretError(`This key file has no ${kind} wrap`);
    assertWrap(wrap);
    const key = await deriveWrapKey(wrap, secret, kind === 'pin' ? options.pepper : undefined);
    const sealed = Buffer.from(wrap.ciphertext, 'base64');
    let privateKey;
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(wrap.nonce, 'base64'));
        decipher.setAAD(aad(file, kind, wrap.pepper));
        decipher.setAuthTag(sealed.subarray(-TAG));
        privateKey = Buffer.concat([
            decipher.update(sealed.subarray(0, -TAG)),
            decipher.final(),
        ]);
    }
    catch {
        throw new WrongSecretError(`That ${kind === 'recovery' ? 'recovery key' : kind} doesn't open this key file`);
    }
    finally {
        key.fill(0);
    }
    const expected = Buffer.from(file.publicKey, 'base64');
    const actual = publicKeyFromPrivate(privateKey);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        privateKey.fill(0);
        throw new Error('The key file is inconsistent: its private key does not match its public key');
    }
    return privateKey;
}
export const hasUnpepperedPinWrap = (file) => file.wraps.some((wrap) => wrap.kind === 'pin' && !wrap.pepper);
export function removeWrap(file, kind) {
    const wraps = file.wraps.filter((wrap) => wrap.kind !== kind);
    if (wraps.length === 0)
        throw new Error('Removing the last wrap would make the key unrecoverable');
    return touch({ ...file, wraps });
}
