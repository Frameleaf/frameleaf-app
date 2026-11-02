import * as React from 'react';
import { Link, Section, Text } from 'react-email';
import { ImmichButton } from 'src/emails/components/button.component.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { SignInReminderEmailProps } from 'src/repositories/email.repository.js';

/** FL-541: an administrator reminds someone to link their Frameleaf account to sign in away from home. */
export const SignInReminderEmail = ({
  baseUrl,
  displayName,
  senderName,
  link,
  showBranding,
}: SignInReminderEmailProps) => (
  <ImmichLayout baseUrl={baseUrl} showBranding={showBranding} preview="Link your Frameleaf account.">
    <Text className="m-0">
      Hey <strong>{displayName}</strong>!
    </Text>

    <Text>
      {senderName} asked you to link your Frameleaf account. Once it is linked, you can sign in to your photos away from
      home. At home, your password keeps working.
    </Text>

    <Section className="flex justify-center my-6">
      <ImmichButton href={link}>Link my Frameleaf account</ImmichButton>
    </Section>

    <Text className="text-xs">
      Sign in with your password first if you are asked. If you cannot click the button, copy this address into your
      browser:
      <br />
      <Link href={link}>{link}</Link>
    </Text>
  </ImmichLayout>
);

SignInReminderEmail.PreviewProps = {
  baseUrl: 'https://photos.example.com',
  displayName: 'Emma',
  senderName: 'Taylor',
  link: 'https://photos.example.com/user-settings?area=preferences&section=frameleaf-account',
} as SignInReminderEmailProps;

export default SignInReminderEmail;
