import * as React from 'react';
import { Link, Row, Text } from 'react-email';
import { EmailMessage, useEmailText } from 'src/emails/components/email-locale.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { TestEmailProps } from 'src/repositories/email.repository.js';

export const TestEmail = ({ baseUrl, displayName, showBranding }: TestEmailProps) => {
  const t = useEmailText();
  return (
    <ImmichLayout baseUrl={baseUrl} showBranding={showBranding} preview={t('test_preview')}>
      <Text className="m-0">
        <EmailMessage id="greeting" values={{ name: <strong>{displayName}</strong> }} />
      </Text>

      <Text>{t('test_body')}</Text>

      {baseUrl ? (
        <Row>
          <Link href={baseUrl}>{baseUrl}</Link>
        </Row>
      ) : (
        <Text>{t('no_link_test')}</Text>
      )}
    </ImmichLayout>
  );
};

TestEmail.PreviewProps = {
  baseUrl: 'https://photos.example.com',
  displayName: 'Alan Turing',
} as TestEmailProps;

export default TestEmail;
