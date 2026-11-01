import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { publicKeyFromPrivate, WrongSecretError } from './format.js';
import { parseRecoveryKey } from './recovery.js';
const FORMAT = 'frameleaf-locked-key/1';
const SCRYPT = { N: 131_072, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const TAG = 16;
const scryptAsync = promisify(scrypt);
const aad = (file, kind) => Buffer.from(`${file.format}|${file.userId}|${kind}`, 'utf8');
const assertFormat = (file) => {
    if (file.format !== FORMAT)
        throw new Error(`Unsupported key file format ${String(file.format)}`);
};
const normalize = (secret) => secret.normalize('NFKC');
const deriveWrapKey = async (wrap, secret) => {
    const salt = Buffer.from(wrap.salt, 'base64');
    if (wrap.kdf === 'hkdf-sha256') {
        let raw;
        try {
            raw = parseRecoveryKey(secret);
        }
        catch {
            throw new WrongSecretError('That is not a valid recovery key');
        }
        return Buffer.from(hkdfSync('sha256', raw, salt, 'frameleaf-locked/1/recovery-wrap', 32));
    }
    return scryptAsync(normalize(secret), salt, 32, { N: wrap.N, r: wrap.r, p: wrap.p, maxmem: SCRYPT_MAXMEM });
};
const touch = (file) => ({ ...file, updatedAt: new Date().toISOString() });
export async function wrapKey(file, privateKey, kind, secret) {
    assertFormat(file);
    if (!publicKeyFromPrivate(privateKey).equals(Buffer.from(file.publicKey, 'base64'))) {
        throw new Error('The private key does not match the key file');
    }
    if (kind === 'pin' && file.mode === 'advanced')
        throw new Error('An advanced key file never holds a PIN wrap');
    if (secret.length === 0)
        throw new Error('The secret is empty');
    const salt = randomBytes(16).toString('base64');
    const params = kind === 'recovery' ? { kdf: 'hkdf-sha256' } : { kdf: 'scrypt', ...SCRYPT };
    const key = await deriveWrapKey({ salt, ...params }, secret);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(file, kind));
    const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final(), cipher.getAuthTag()]);
    key.fill(0);
    const wrap = {
        kind,
        ...params,
        salt,
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    };
    return touch({ ...file, wraps: [...(file.wraps ?? []).filter((existing) => existing.kind !== kind), wrap] });
}
export async function unwrapKey(file, kind, secret) {
    assertFormat(file);
    const wrap = file.wraps.find((candidate) => candidate.kind === kind);
    if (!wrap)
        throw new WrongSecretError(`This key file has no ${kind} wrap`);
    const key = await deriveWrapKey(wrap, secret);
    const sealed = Buffer.from(wrap.ciphertext, 'base64');
    let privateKey;
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(wrap.nonce, 'base64'));
        decipher.setAAD(aad(file, kind));
        decipher.setAuthTag(sealed.subarray(-TAG));
        privateKey = Buffer.concat([decipher.update(sealed.subarray(0, -TAG)), decipher.final()]);
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
export function removeWrap(file, kind) {
    const wraps = file.wraps.filter((wrap) => wrap.kind !== kind);
    if (wraps.length === 0)
        throw new Error('Removing the last wrap would make the key unrecoverable');
    return touch({ ...file, wraps });
}
