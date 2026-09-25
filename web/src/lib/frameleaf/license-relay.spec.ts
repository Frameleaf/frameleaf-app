import { beforeEach, describe, expect, it } from 'vitest';
import {
  PENDING_LICENSE_KEY,
  holdPendingLicenseKey,
  parseLinkFragment,
  takePendingLicenseKey,
} from '$lib/frameleaf/license-relay';

describe('licence key relay (FL-157)', () => {
  beforeEach(() => sessionStorage.clear());

  it('reads the target and key from the fragment only', () => {
    expect(parseLinkFragment('#target=frameleaf_license&key=FL-S8NL-49G8-J58U')).toEqual({
      target: 'frameleaf_license',
      key: 'FL-S8NL-49G8-J58U',
    });
    expect(parseLinkFragment('')).toEqual({ target: null, key: null });
  });

  it('keeps a key in session storage once, and hands it over once', () => {
    expect(holdPendingLicenseKey(' fl-s8nl-49g8-j58u ')).toBe(true);
    expect(sessionStorage.getItem(PENDING_LICENSE_KEY)).toBe('FL-S8NL-49G8-J58U');
    expect(takePendingLicenseKey()).toBe('FL-S8NL-49G8-J58U');
    expect(takePendingLicenseKey()).toBeNull();
  });

  it('refuses anything that is not shaped like a Frameleaf key', () => {
    expect(holdPendingLicenseKey('IMCL-AAAA-BBBB-CCCC-DDDD')).toBe(false);
    expect(holdPendingLicenseKey('<script>')).toBe(false);
    expect(sessionStorage.getItem(PENDING_LICENSE_KEY)).toBeNull();
  });
});
