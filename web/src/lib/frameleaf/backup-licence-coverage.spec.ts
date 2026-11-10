import { CloudBackupLicenceScope } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { backupLicenceCoverage } from './backup-licence-coverage';

describe('Cloud Backup account cover', () => {
  it('names covered members instead of the signed-in administrator', () => {
    expect(
      backupLicenceCoverage(
        { scope: CloudBackupLicenceScope.Users, accounts: [{ userId: 'member', name: 'Member' }] },
        'en',
      ).values,
    ).toEqual({ name: 'Member' });
    expect(
      backupLicenceCoverage(
        {
          scope: CloudBackupLicenceScope.Users,
          accounts: [
            { userId: 'a', name: 'Ada' },
            { userId: 'b', name: 'Ben' },
          ],
        },
        'en',
      ).values,
    ).toEqual({ name: 'Ada and Ben' });
  });
  it('keeps missing or unresolvable coverage unknown', () => {
    for (const coverage of [
      null,
      { scope: CloudBackupLicenceScope.Unknown, accounts: [] },
      { scope: CloudBackupLicenceScope.Users, accounts: [] },
    ]) {
      expect(backupLicenceCoverage(coverage, 'en')).toMatchObject({ known: false, key: 'frameleaf_lic_cover_unknown' });
    }
  });
  it('distinguishes confirmed none from all', () => {
    expect(backupLicenceCoverage({ scope: CloudBackupLicenceScope.None, accounts: [] }, 'en')).toMatchObject({
      known: true,
      key: 'frameleaf_lic_no_accounts',
    });
    expect(backupLicenceCoverage({ scope: CloudBackupLicenceScope.All, accounts: [] }, 'en')).toMatchObject({
      known: true,
      key: 'frameleaf_lic_everyone',
    });
  });
});
