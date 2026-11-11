import * as React from 'react';
import { EmailMessage, useEmailText } from 'src/emails/components/email-locale.js';
import { Link, Section, Text } from 'react-email';
import { ImmichButton } from 'src/emails/components/button.component.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { PasswordLinkEmailProps } from 'src/repositories/email.repository.js';

/** FL-538: an administrator added someone (or helps them back in) with a link to choose a password. */
export const PasswordLinkEmail = ({
  baseUrl,
  displayName,
  username,
  link,
  senderName,
  isNew,
  showBranding,
}: PasswordLinkEmailProps) => {
  const t = useEmailText();
  return (
    <ImmichLayout baseUrl={baseUrl} showBranding={showBranding} preview={t('password_link_preview')}>
      <Text className="m-0">
        <EmailMessage id="greeting" values={{ name: <strong>{displayName}</strong> }} />
      </Text>

      <Text>{t(isNew ? 'password_link_new' : 'password_link_reset', { senderName })}</Text>

      <Text>
        <strong>{t('you_sign_in_with')}</strong>: {username}
      </Text>

      <Section className="flex justify-center my-6">
        <ImmichButton href={link}>{t('choose_password')}</ImmichButton>
      </Section>

      <Text className="text-xs">
        {t('password_link_help')}
        <br />
        <Link href={link}>{link}</Link>
      </Text>
    </ImmichLayout>
  );
};

PasswordLinkEmail.PreviewProps = {
  baseUrl: 'https://photos.example.com',
  displayName: 'Alan Turing',
  username: 'alanturing@example.com',
  link: 'https://photos.example.com/auth/choose-password#token',
  senderName: 'Taylor',
  isNew: true,
} as PasswordLinkEmailProps;

export default PasswordLinkEmail;
