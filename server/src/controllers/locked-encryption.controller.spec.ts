import { HEADERS_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { LockedEncryptionController } from 'src/controllers/locked-encryption.controller.js';
import { Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';

const reflector = new Reflector();
const route = LockedEncryptionController.prototype;
const headersOf = (method: (...args: never[]) => unknown) =>
  // eslint-disable-next-line unicorn/no-nonstandard-builtin-properties
  (Reflect.getMetadata(HEADERS_METADATA, method) ?? []) as { name: string; value: string }[];

describe(LockedEncryptionController.name, () => {
  it('serves only the signed-in person, under users/me', () => {
    // eslint-disable-next-line unicorn/no-nonstandard-builtin-properties
    expect(Reflect.getMetadata(PATH_METADATA, LockedEncryptionController)).toBe('users/me/locked-encryption');
  });

  it('reads with user preference read and changes with user preference update; never admin or shared links', () => {
    expect(getAuthenticatedOptions(reflector, route.getLockedEncryption)).toMatchObject({
      permission: Permission.UserPreferenceRead,
      sharedLink: false,
    });
    for (const method of [
      'enableLockedEncryption',
      'disableLockedEncryption',
      'updateLockedEncryption',
      'unlockLockedEncryption',
      'unlockPartnerLockedEncryption',
      'lockLockedEncryption',
      'createLockedEncryptionRecoveryKey',
      'recoverLockedEncryption',
    ] as const) {
      const options = getAuthenticatedOptions(reflector, route[method]);
      expect(options).toMatchObject({ permission: Permission.UserPreferenceUpdate, sharedLink: false });
      expect(options).not.toMatchObject({ admin: true });
    }
  });

  it('marks the two responses that carry a recovery key Cache-Control: no-store', () => {
    for (const method of [route.enableLockedEncryption, route.createLockedEncryptionRecoveryKey]) {
      expect(headersOf(method)).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
    }
  });
});
