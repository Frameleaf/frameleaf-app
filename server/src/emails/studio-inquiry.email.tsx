import * as React from 'react';
import { Link, Section, Text } from 'react-email';
import { ImmichButton } from 'src/emails/components/button.component.js';
import { EmailMessage, useEmailText } from 'src/emails/components/email-locale.js';
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
}: StudioInquiryEmailProps) => {
  const t = useEmailText();
  return (
    <ImmichLayout
      baseUrl={baseUrl}
      showBranding={showBranding}
      preview={t(kind === 'gallery-link' ? 'inquiry_gallery_preview' : 'inquiry_preview', { email, name })}
    >
      {kind === 'gallery-link' ? (
        <Text className="m-0">
          <EmailMessage id="inquiry_gallery_body" values={{ email: <strong>{email}</strong>, studioName }} />
        </Text>
      ) : (
        <>
          <Text className="m-0">
            <EmailMessage id="inquiry_body" values={{ name: <strong>{name}</strong>, studioName }} />
          </Text>
          <Text>
            <EmailMessage id="inquiry_email" values={{ email: <Link href={`mailto:${email}`}>{email}</Link> }} />
            <br />
            {t('inquiry_planning', { type: type || t('not_said') })}
            {date ? (
              <>
                <br />
                {t('inquiry_date', { date })}
              </>
            ) : null}
          </Text>
          <Text style={{ whiteSpace: 'pre-wrap' }}>{message}</Text>
          <Text className="text-xs">{t('inquiry_reply', { email, name })}</Text>
        </>
      )}
      {link ? (
        <Section className="flex justify-center my-6">
          <ImmichButton href={link}>{t('open_clients')}</ImmichButton>
        </Section>
      ) : null}
    </ImmichLayout>
  );
};

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
