import * as React from 'react';
import { Link, Section, Text } from 'react-email';
import { ImmichButton } from 'src/emails/components/button.component.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { StudioInquiryEmailProps } from 'src/repositories/email.repository.js';

/** FL-702: a message from the studio website, sent to the photographer. */
export const StudioInquiryEmail = ({
  baseUrl,
  studioName,
  kind,
  name,
  email,
  date,
  type,
  message,
  link,
  showBranding,
}: StudioInquiryEmailProps) => (
  <ImmichLayout
    baseUrl={baseUrl}
    showBranding={showBranding}
    preview={kind === 'gallery-link' ? `${email} asked for their gallery link.` : `New inquiry from ${name}.`}
  >
    {kind === 'gallery-link' ? (
      <Text className="m-0">
        Someone at <strong>{email}</strong> asked {studioName}'s website for their gallery link. If they are your
        client, send them their link again from Clients.
      </Text>
    ) : (
      <>
        <Text className="m-0">
          <strong>{name}</strong> sent an inquiry from {studioName}'s website.
        </Text>
        <Text>
          Email: <Link href={`mailto:${email}`}>{email}</Link>
          <br />
          Planning: {type || 'Not said'}
          {date ? (
            <>
              <br />
              Date: {date}
            </>
          ) : null}
        </Text>
        <Text style={{ whiteSpace: 'pre-wrap' }}>{message}</Text>
        <Text className="text-xs">
          To answer, write to {email}. This email comes from your server, so replying to it does not reach {name}.
        </Text>
      </>
    )}
    {link ? (
      <Section className="flex justify-center my-6">
        <ImmichButton href={link}>Open Clients</ImmichButton>
      </Section>
    ) : null}
  </ImmichLayout>
);

StudioInquiryEmail.PreviewProps = {
  baseUrl: 'https://photos.example.com',
  studioName: 'Cedar & Light',
  kind: 'inquiry',
  name: 'Sam Rivera',
  email: 'sam@example.com',
  date: '2027-06-12',
  type: 'Family',
  message: 'A family session in Banff next June?',
  link: 'https://photos.example.com/photography?section=website',
} as StudioInquiryEmailProps;

export default StudioInquiryEmail;
