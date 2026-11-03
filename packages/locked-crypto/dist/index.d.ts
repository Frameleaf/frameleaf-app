export { LOCKED_MAGIC, LockedFileCorruptError, SEGMENT_SIZE, WrongSecretError, decryptFile, encryptFile, generateKeyPair, isLockedFile, keyId, openDecrypt, readHeader, rewrapFile, verifyFile, } from './format.js';
export type { LockedFileInfo, LockedFileKind, LockedHeader, Recipient, } from './format.js';
export { KEY_FILE_FORMAT_1, KEY_FILE_FORMAT_2, KEY_FILE_FORMATS, LockedKeyFileCorruptError, LockedPepperError, PEPPER_BYTES, hasUnpepperedPinWrap, isKeyFileFormat, pepperId, removeWrap, unwrapKey, wrapKey, } from './keys.js';
export type { KeyWrap, LockedKeyFile, LockedKeyFileFormat, WrapKind, WrapOptions, } from './keys.js';
export { generateRecoveryKey, parseRecoveryKey } from './recovery.js';
