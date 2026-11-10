import * as React from 'react';
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
  const passed = data.result === 'passed';
  return (
    <ImmichLayout
      baseUrl={baseUrl}
      showBranding={showBranding}
      preview={passed ? 'Your backup restored correctly' : 'Your backup didn’t restore'}
    >
      <Text className="text-xl font-bold">{passed ? 'Your backup works' : 'Your backup didn’t restore'}</Text>
      <Text>
        {passed
          ? `Last night Frameleaf took ${data.sample} photos and videos back from your ${data.source} backup and checked them against your library. All of them matched.`
          : `Last night Frameleaf tried to take a sample back from your ${data.source} backup. ${data.failure ?? ''} Your backups are still running.`}
      </Text>
      <Text>
        Drill: {data.ranAt} (every 30 days)
        <br />
        Backup: {data.source}
        {data.backupFrom ? `, ${data.backupFrom}` : ''} (the newest one)
        <br />
        Result: {passed ? `${data.matched} of ${data.sample} matched` : `Stopped at “${data.stoppedAt}”`} (took{' '}
        {data.duration})
      </Text>
      {baseUrl && (
        <Section className="my-6">
          <ImmichButton href={`${baseUrl}${data.link}`}>
            {passed ? 'See the report' : 'Check the recovery key'}
          </ImmichButton>
        </Section>
      )}
      <Text className="text-sm">
        You get this because you look after this server. Turn emails off in your account’s notification settings.
      </Text>
    </ImmichLayout>
  );
};
