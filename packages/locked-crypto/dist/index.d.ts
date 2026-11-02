export { LOCKED_MAGIC, LockedFileCorruptError, SEGMENT_SIZE, WrongSecretError, decryptFile, encryptFile, generateKeyPair, isLockedFile, keyId, openDecrypt, readHeader, rewrapFile, verifyFile, } from './format.js';
export type { LockedFileInfo, LockedFileKind, LockedHeader, Recipient } from './format.js';
export { removeWrap, unwrapKey, wrapKey } from './keys.js';
export type { KeyWrap, LockedKeyFile, WrapKind } from './keys.js';
export { generateRecoveryKey, parseRecoveryKey } from './recovery.js';
