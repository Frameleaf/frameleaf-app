import * as React from 'react';
import { Link, Section, Text } from 'react-email';
import { ImmichButton } from 'src/emails/components/button.component.js';
import { EmailMessage, useEmailText } from 'src/emails/components/email-locale.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { SignInReminderEmailProps } from 'src/repositories/email.repository.js';

/** FL-541: an administrator reminds someone to link their Frameleaf account to sign in away from home. */
export const SignInReminderEmail = ({
  baseUrl,
  displayName,
  senderName,
  link,
  showBranding,
}: SignInReminderEmailProps) => {
  const t = useEmailText();
  return (
    <ImmichLayout baseUrl={baseUrl} showBranding={showBranding} preview={t('sign_in_reminder_preview')}>
      <Text className="m-0">
        <EmailMessage id="greeting" values={{ name: <strong>{displayName}</strong> }} />
      </Text>

      <Text>{t('sign_in_reminder_body', { senderName })}</Text>

      <Section className="flex justify-center my-6">
        <ImmichButton href={link}>{t('link_frameleaf_account')}</ImmichButton>
      </Section>

      <Text className="text-xs">
        {t('sign_in_reminder_help')}
        <br />
        <Link href={link}>{link}</Link>
      </Text>
    </ImmichLayout>
  );
};

SignInReminderEmail.PreviewProps = {
  baseUrl: 'https://photos.example.com',
  displayName: 'Emma',
  senderName: 'Taylor',
  link: 'https://photos.example.com/user-settings?area=preferences&section=frameleaf-account',
} as SignInReminderEmailProps;

export default SignInReminderEmail;
