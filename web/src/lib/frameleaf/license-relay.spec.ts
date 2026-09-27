import { beforeEach, describe, expect, it } from 'vitest';
import {
  KEY_IN_LINK_NOTICE,
  PENDING_LINK_CODE,
  holdKeyInLinkNotice,
  holdPendingLinkCode,
  isLicenseRelay,
  readLinkAddress,
  takeKeyInLinkNotice,
  takePendingLinkCode,
} from '$lib/frameleaf/license-relay';

const CODE = 'flc_ABCDEFGHJKMNPQRSTVWXYZ2345';
const KEY = 'FL-S8NL-49G8-J583';

describe('licence link relay (CLD-004)', () => {
  beforeEach(() => sessionStorage.clear());

  it('reads a one-time link code from the query, and nothing that is not shaped like one', () => {
    expect(readLinkAddress(`https://photos.test/link?target=frameleaf_license&linkCode=${CODE}`)).toEqual({
      target: 'frameleaf_license',
      linkCode: CODE,
      carriedKey: false,
    });
    expect(readLinkAddress('/link?linkCode=flc_short').linkCode).toBeNull();
    expect(readLinkAddress('/link?linkCode=<script>').linkCode).toBeNull();
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

  it('remembers the "paste the key" notice once, without the key', () => {
    holdKeyInLinkNotice();
    expect(sessionStorage.getItem(KEY_IN_LINK_NOTICE)).toBe('1');
    expect(takeKeyInLinkNotice()).toBe(true);
    expect(takeKeyInLinkNotice()).toBe(false);
  });
});
