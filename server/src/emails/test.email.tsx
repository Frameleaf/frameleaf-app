import { Link, Row, Text } from '@react-email/components';
import * as React from 'react';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { NO_LINK_TEST } from 'src/emails/components/no-link.js';
import { TestEmailProps } from 'src/repositories/email.repository.js';

export const TestEmail = ({ baseUrl, displayName }: TestEmailProps) => (
  <ImmichLayout baseUrl={baseUrl} preview="This is a test email from Frameleaf.">
    <Text className="m-0">
      Hey <strong>{displayName}</strong>!
    </Text>

    <Text>This is a test email from your Frameleaf server!</Text>

    {baseUrl ? (
      <Row>
        <Link href={baseUrl}>{baseUrl}</Link>
      </Row>
    ) : (
      <Text>{NO_LINK_TEST}</Text>
    )}
  </ImmichLayout>
);

TestEmail.PreviewProps = {
  baseUrl: 'https://photos.example.com',
  displayName: 'Alan Turing',
} as TestEmailProps;

export default TestEmail;
