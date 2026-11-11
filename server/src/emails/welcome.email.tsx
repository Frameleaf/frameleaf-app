import { toPlainText } from '@react-email/render';
import * as React from 'react';
import { EmailMessage, useEmailText } from 'src/emails/components/email-locale.js';
import { Link, Section, Text } from 'react-email';
import { ImmichButton } from 'src/emails/components/button.component.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { WelcomeEmailProps } from 'src/repositories/email.repository.js';
import { replaceTemplateTags } from 'src/utils/replace-template-tags.js';

export const WelcomeEmail = ({
  baseUrl,
  displayName,
  username,
  password,
  customTemplate,
  showBranding,
}: WelcomeEmailProps) => {
  const t = useEmailText();
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
        <EmailMessage id="greeting" values={{ name: <strong>{displayName}</strong> }} />
      </Text>

      <Text>{t('welcome_body')}</Text>

      <Text>
        <strong>{t('username')}</strong>: {username}
        {password && (
          <>
            <br />
            <strong>{t('password')}</strong>: {password}
          </>
        )}
      </Text>
    </>
  );

  return (
    <ImmichLayout
      baseUrl={baseUrl}
      showBranding={showBranding}
      preview={customTemplate ? toPlainText(emailContent.toString()) : t('welcome_preview')}
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
            <ImmichButton href={`${baseUrl}/auth/login`}>{t('login')}</ImmichButton>
          </Section>

          <Text className="text-xs">
            {t('welcome_link_help')}
            <br />
            <Link href={baseUrl}>{baseUrl}</Link>
          </Text>
        </>
      ) : (
        <Text>{t('no_link_sign_in')}</Text>
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
