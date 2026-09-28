import { beforeEach, describe, expect, it } from 'vitest';
import {
  KEY_IN_LINK_NOTICE,
  PENDING_LINK_CODE,
  holdLinkNotice,
  holdPendingLinkCode,
  isLicenseRelay,
  readLinkAddress,
  takeLinkNotice,
  takePendingLinkCode,
} from '$lib/frameleaf/license-relay';

const CODE = 'flc_jf23qnbc4wvmpnuogenclb2hyo';
const KEY = 'FL-S8NL-49G8-J583';

describe('licence link relay (CLD-004)', () => {
  beforeEach(() => sessionStorage.clear());

  it('reads a one-time link code from the query, and nothing that is not shaped like one', () => {
    expect(readLinkAddress(`https://photos.test/link?target=frameleaf_license&linkCode=${CODE}`)).toEqual({
      target: 'frameleaf_license',
      linkCode: CODE,
      carriedKey: false,
      invalidLinkCode: false,
    });
    // Frameleaf Cloud's LICENSE_LINK_CODE_RE: flc_ and 26 lower-case base32 symbols
    for (const code of [
      'flc_short',
      '<script>',
      CODE.toUpperCase(),
      `${CODE}a`,
      'flc_jf23qnbc4wvmpnuogenclb2hy0',
      '',
    ]) {
      const read = readLinkAddress(`/link?target=frameleaf_license&linkCode=${encodeURIComponent(code)}`);
      expect(read.linkCode).toBeNull();
      expect(read.invalidLinkCode).toBe(true);
      expect(isLicenseRelay(`/link?linkCode=${encodeURIComponent(code)}`)).toBe(true);
    }
  });

  it('detects a key in any old link form, and never returns it', () => {
    for (const href of [
      `/link?target=activate_license&licenseKey=${KEY}`,
      `/link?key=${KEY}`,
      `/link?license_key=x`,
      `/link#target=frameleaf_license&key=${KEY}`,
      `/link?target=frameleaf_license&linkCode=${CODE}&x=${encodeURIComponent(KEY)}`,
      `/link?anything=${KEY.toLowerCase()}`,
    ]) {
      const read = readLinkAddress(href);
      expect(read.carriedKey).toBe(true);
      expect(JSON.stringify(read)).not.toContain(KEY);
      expect(isLicenseRelay(href)).toBe(true);
    }
  });

  it('leaves ordinary /link targets to the load function', () => {
    expect(isLicenseRelay('/link?target=view_asset&id=1')).toBe(false);
    expect(isLicenseRelay('/link?target=frameleaf_account')).toBe(false);
    expect(isLicenseRelay('/link')).toBe(false);
  });

  it('keeps a link code in session storage once, and hands it over once', () => {
    expect(holdPendingLinkCode(CODE)).toBe(true);
    expect(sessionStorage.getItem(PENDING_LINK_CODE)).toBe(CODE);
    expect(takePendingLinkCode()).toBe(CODE);
    expect(takePendingLinkCode()).toBeNull();
    expect(holdPendingLinkCode(KEY)).toBe(false);
    expect(sessionStorage.getItem(PENDING_LINK_CODE)).toBeNull();
  });

  it('drops a key the old relay left in session storage', () => {
    sessionStorage.setItem('frameleaf:license:pending', KEY);
    expect(takePendingLinkCode()).toBeNull();
    expect(sessionStorage.getItem('frameleaf:license:pending')).toBeNull();
  });

  it('remembers the "paste the key" notice once, without the key or the code', () => {
    holdLinkNotice('key-in-link');
    expect(sessionStorage.getItem(KEY_IN_LINK_NOTICE)).toBe('key-in-link');
    expect(takeLinkNotice()).toBe('key-in-link');
    expect(takeLinkNotice()).toBeNull();
    holdLinkNotice('invalid-code');
    expect(takeLinkNotice()).toBe('invalid-code');
    sessionStorage.setItem(KEY_IN_LINK_NOTICE, 'something else');
    expect(takeLinkNotice()).toBeNull();
  });
});
