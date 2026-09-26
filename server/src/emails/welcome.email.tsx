import { Link, Section, Text } from '@react-email/components';
import * as React from 'react';
import { ImmichButton } from 'src/emails/components/button.component.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { NO_LINK_SIGN_IN } from 'src/emails/components/no-link.js';
import { WelcomeEmailProps } from 'src/repositories/email.repository.js';
import { replaceTemplateTags } from 'src/utils/replace-template-tags.js';

export const WelcomeEmail = ({ baseUrl, displayName, username, password, customTemplate }: WelcomeEmailProps) => {
  const usableTemplateVariables = {
    displayName,
    username,
    password,
    baseUrl: baseUrl ?? '',
  };

  const emailContent = customTemplate ? (
    replaceTemplateTags(customTemplate, usableTemplateVariables)
  ) : (
    <>
      <Text className="m-0">
        Hey <strong>{displayName}</strong>!
      </Text>

      <Text>A new account has been created for you.</Text>

      <Text>
        <strong>Username</strong>: {username}
        {password && (
          <>
            <br />
            <strong>Password</strong>: {password}
          </>
        )}
      </Text>
    </>
  );

  return (
    <ImmichLayout
      baseUrl={baseUrl}
      preview={customTemplate ? emailContent.toString() : 'You have been invited to a Frameleaf server.'}
    >
      {customTemplate && (
        <Text className="m-0">
          <div dangerouslySetInnerHTML={{ __html: emailContent }}></div>
        </Text>
      )}

      {!customTemplate && emailContent}

      {baseUrl ? (
        <>
          <Section className="flex justify-center my-6">
            <ImmichButton href={`${baseUrl}/auth/login`}>Login</ImmichButton>
          </Section>

          <Text className="text-xs">
            If you cannot click the button use the link below to proceed with first login.
            <br />
            <Link href={baseUrl}>{baseUrl}</Link>
          </Text>
        </>
      ) : (
        <Text>{NO_LINK_SIGN_IN}</Text>
      )}
    </ImmichLayout>
  );
};

WelcomeEmail.PreviewProps = {
  baseUrl: 'https://photos.example.com/auth/login',
  displayName: 'Alan Turing',
  username: 'alanturing@example.com',
  password: 'mysuperpassword',
} as WelcomeEmailProps;

export default WelcomeEmail;
