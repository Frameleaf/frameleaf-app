import * as React from 'react';
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
}: PasswordLinkEmailProps) => (
  <ImmichLayout baseUrl={baseUrl} showBranding={showBranding} preview="Choose your Frameleaf password.">
    <Text className="m-0">
      Hey <strong>{displayName}</strong>!
    </Text>

    <Text>
      {isNew
        ? `${senderName} added you to their Frameleaf server. Choose a password to sign in.`
        : `${senderName} sent you a link to choose a new password for Frameleaf.`}
    </Text>

    <Text>
      <strong>You sign in with</strong>: {username}
    </Text>

    <Section className="flex justify-center my-6">
      <ImmichButton href={link}>Choose a password</ImmichButton>
    </Section>

    <Text className="text-xs">
      The link works once and stops working after 7 days. If you cannot click the button, copy this address into your
      browser:
      <br />
      <Link href={link}>{link}</Link>
    </Text>
  </ImmichLayout>
);

PasswordLinkEmail.PreviewProps = {
  baseUrl: 'https://photos.example.com',
  displayName: 'Alan Turing',
  username: 'alanturing@example.com',
  link: 'https://photos.example.com/auth/choose-password#token',
  senderName: 'Taylor',
  isNew: true,
} as PasswordLinkEmailProps;

export default PasswordLinkEmail;
