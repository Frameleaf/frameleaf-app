import * as React from 'react';
import { Section, Text } from 'react-email';
import { ImmichButton } from 'src/emails/components/button.component.js';
import { EmailMessage, useEmailText } from 'src/emails/components/email-locale.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { GalleryInviteEmailProps } from 'src/repositories/email.repository.js';

/** A studio invites its client to a proof gallery (approved design, 2026-11-04: Gallery › Invite client). */
export const GalleryInviteEmail = ({
  reminder,
  baseUrl,
  studioName,
  recipientName,
  galleryTitle,
  welcomeMessage,
  link,
  expiresAt,
  showBranding,
}: GalleryInviteEmailProps) => {
  const t = useEmailText();
  return reminder ? (
    // The reminder cannot carry the private link (only its fingerprint is kept), so it points to the invitation.
    <ImmichLayout
      baseUrl={baseUrl}
      showBranding={showBranding}
      preview={t('gallery_reminder_preview', { galleryTitle })}
    >
      <Text className="m-0">{t('greeting_client', { name: recipientName })}</Text>
      <Text>
        {t(
          reminder === 'selection'
            ? 'gallery_selection_body'
            : reminder === 'payment'
              ? 'gallery_payment_body'
              : 'gallery_expiry_body',
          { studioName, galleryTitle, expiresAt: expiresAt ?? t('soon') },
        )}
      </Text>
      <Text>{t('gallery_reminder_link', { studioName })}</Text>
    </ImmichLayout>
  ) : (
    <ImmichLayout
      baseUrl={baseUrl}
      showBranding={showBranding}
      preview={t('gallery_invite_preview', { studioName, galleryTitle })}
    >
      <Text className="m-0">{t('greeting_client', { name: recipientName })}</Text>
      <Text>
        <EmailMessage id="gallery_invite_body" values={{ studioName, galleryTitle: <strong>{galleryTitle}</strong> }} />
      </Text>
      {welcomeMessage ? <Text style={{ whiteSpace: 'pre-wrap' }}>{welcomeMessage}</Text> : null}
      <Section className="flex justify-center my-6">
        <ImmichButton href={link}>{t('open_gallery')}</ImmichButton>
      </Section>
      {expiresAt ? <Text className="text-xs">{t('gallery_link_expiry', { expiresAt })}</Text> : null}
      <Text className="text-xs">{t('gallery_link_privacy', { studioName })}</Text>
    </ImmichLayout>
  );
};

GalleryInviteEmail.PreviewProps = {
  baseUrl: 'https://photos.example.com',
  studioName: 'Cedar & Light',
  recipientName: 'Jamie',
  galleryTitle: 'An afternoon together',
  welcomeMessage: 'Take your time. Choose the photographs you love and leave a note for me.',
  link: 'https://photos.example.com/photography/gallery/00000000-0000-4000-8000-000000000001#invitation=abc',
  expiresAt: 'December 4, 2026',
} as GalleryInviteEmailProps;

export default GalleryInviteEmail;
