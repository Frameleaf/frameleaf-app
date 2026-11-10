import * as React from 'react';
import { Section, Text } from 'react-email';
import type { NewSignInEmailProps } from 'src/repositories/email.repository.js';
import { ImmichButton } from 'src/emails/components/button.component.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { SIGN_IN_SECURITY_URL } from 'src/utils/sign-in-security.js';

export const NewSignInEmail = ({ baseUrl, showBranding, ...data }: NewSignInEmailProps) => (
  <ImmichLayout
    baseUrl={baseUrl}
    showBranding={showBranding}
    preview={
      data.kind === 'new-device' ? 'New sign-in to your Frameleaf Library' : 'Someone tried to sign in to your account'
    }
  >
    {data.kind === 'new-device' ? (
      <>
        <Text>Your Frameleaf Library account signed in from a device it hasn’t seen before.</Text>
        <Text>
          Device: {data.device}
          <br />
          Place: {data.place}
          <br />
          Time: {data.time}
        </Text>
      </>
    ) : (
      <Text>There were repeated unsuccessful attempts to sign in to your Frameleaf Library account.</Text>
    )}
    <Text>
      If this wasn’t you, review your signed-in devices, sign out any you don’t recognize and change your password.
    </Text>
    {baseUrl && (
      <Section className="my-6">
        <ImmichButton href={`${baseUrl}${SIGN_IN_SECURITY_URL}`}>This wasn’t me</ImmichButton>
      </Section>
    )}
  </ImmichLayout>
);
