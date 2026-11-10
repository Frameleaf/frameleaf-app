import type { CloudBackupLicenceCoverageResponseDto } from '@frameleaf/sdk';

/** Labels for Cloud's current scope. A local key or old backup receipt is not coverage evidence. */
export const backupLicenceCoverage = (
  coverage: CloudBackupLicenceCoverageResponseDto | null | undefined,
  locale: string,
) => {
  if (coverage?.scope === 'all') {
    return { key: 'frameleaf_lic_everyone' as const, tone: 'good' as const, known: true, values: undefined };
  }
  if (coverage?.scope === 'none') {
    return { key: 'frameleaf_lic_no_accounts' as const, tone: 'off' as const, known: true, values: undefined };
  }
  if (coverage?.scope === 'users' && coverage.accounts.length > 0) {
    return {
      key: 'frameleaf_lic_only' as const,
      tone: 'warn' as const,
      known: true,
      values: {
        name: new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(
          coverage.accounts.map((account) => account.name),
        ),
      },
    };
  }
  // No local account matches an opaque Cloud fingerprint: never substitute the administrator.
  return { key: 'frameleaf_lic_cover_unknown' as const, tone: 'quiet' as const, known: false, values: undefined };
};
