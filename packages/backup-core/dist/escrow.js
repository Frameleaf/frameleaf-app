import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
export const ESCROW_SCRYPT = Object.freeze({ N: 131_072, r: 8, p: 1 });
const ESCROW_SCRYPT_MAXMEM = 256 * 1024 * 1024;
const ESCROW_SALT_BYTES = 16;
const ESCROW_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;
const ESCROW_AAD = Buffer.from('frameleaf-backup-key-escrow/1');
export const ESCROW_MIN_PASSPHRASE = 12;
export const ESCROW_BLOB_VERSION = 1;
export const scryptDerive = (passphrase, salt, options) => new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFKC'), salt, options.keyLength, { N: options.N, r: options.r, p: options.p, maxmem: ESCROW_SCRYPT_MAXMEM }, (error, key) => (error ? reject(error) : resolve(key)));
});
const wrappingKey = (passphrase, salt) => scryptDerive(passphrase, salt, { ...ESCROW_SCRYPT, keyLength: 32 });
export const escrowPassphraseProblem = (passphrase) => passphrase.normalize('NFKC').length < ESCROW_MIN_PASSPHRASE
    ? `Use a passphrase of at least ${ESCROW_MIN_PASSPHRASE} characters.`
    : null;
export const wrapBucketKey = async (key, passphrase, options = {}) => {
    if (key.length !== KEY_BYTES) {
        throw new Error('A bucket key is 256 bits');
    }
    const problem = escrowPassphraseProblem(passphrase);
    if (problem) {
        throw new Error(problem);
    }
    const salt = options.salt ?? randomBytes(ESCROW_SALT_BYTES);
    const nonce = options.nonce ?? randomBytes(ESCROW_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', await wrappingKey(passphrase, salt), nonce);
    cipher.setAAD(ESCROW_AAD);
    const ciphertext = Buffer.concat([cipher.update(key), cipher.final(), cipher.getAuthTag()]);
    return {
        version: ESCROW_BLOB_VERSION,
        kdf: { name: 'scrypt', ...ESCROW_SCRYPT, salt: salt.toString('base64') },
        cipher: 'aes-256-gcm',
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    };
};
export const unwrapBucketKey = async (blob, passphrase) => {
    const sealed = Buffer.from(blob.ciphertext, 'base64');
    if (sealed.length <= GCM_TAG_BYTES) {
        throw new Error('This key copy is damaged.');
    }
    const salt = Buffer.from(blob.kdf.salt, 'base64');
    const key = await scryptDerive(passphrase, salt, { N: blob.kdf.N, r: blob.kdf.r, p: blob.kdf.p, keyLength: 32 });
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.nonce, 'base64'));
    decipher.setAAD(ESCROW_AAD);
    decipher.setAuthTag(sealed.subarray(sealed.length - GCM_TAG_BYTES));
    let opened;
    try {
        opened = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - GCM_TAG_BYTES)), decipher.final()]);
    }
    catch {
        throw new Error('This passphrase does not open the key copy.');
    }
    if (opened.length !== KEY_BYTES) {
        throw new Error('This key copy does not hold a bucket key.');
    }
    return opened;
};
