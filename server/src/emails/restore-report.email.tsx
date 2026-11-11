import * as React from 'react';
import { useEmailText } from 'src/emails/components/email-locale.js';
import { Section, Text } from 'react-email';
import type { RestoreReportEmailProps } from 'src/repositories/email.repository.js';
import { ImmichButton } from 'src/emails/components/button.component.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';

/**
 * FL-900: sent to administrators after each scheduled restore drill (FL-879), passed or failed. It says
 * what was proved, from which backup, and links to the signed report (or the recovery key when the
 * backup could not be unlocked).
 */
export const RestoreReportEmail = ({ baseUrl, showBranding, ...data }: RestoreReportEmailProps) => {
  const t = useEmailText();
  const passed = data.result === 'passed';
  return (
    <ImmichLayout
      baseUrl={baseUrl}
      showBranding={showBranding}
      preview={t(passed ? 'restore_passed_preview' : 'restore_failed_preview')}
    >
      <Text className="text-xl font-bold">{t(passed ? 'restore_passed_heading' : 'restore_failed_preview')}</Text>
      <Text>
        {t(passed ? 'restore_passed_body' : 'restore_failed_body', {
          sample: data.sample,
          source: data.source,
          failure: data.failure ?? '',
        })}
      </Text>
      <Text>
        {t('restore_drill', { ranAt: data.ranAt })}
        <br />
        {t('restore_backup', {
          source: data.source,
          backupFrom: data.backupFrom ? t('restore_backup_from', { date: data.backupFrom }) : '',
        })}
        <br />
        {t('restore_result', {
          result: passed
            ? t('restore_matched', { matched: data.matched, sample: data.sample })
            : t('restore_stopped', { step: data.stoppedAt ?? '' }),
          duration: data.duration,
        })}
      </Text>
      {baseUrl && (
        <Section className="my-6">
          <ImmichButton href={`${baseUrl}${data.link}`}>{t(passed ? 'see_report' : 'check_recovery_key')}</ImmichButton>
        </Section>
      )}
      <Text className="text-sm">{t('restore_footer')}</Text>
    </ImmichLayout>
  );
};
