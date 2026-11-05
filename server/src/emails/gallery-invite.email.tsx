import * as React from 'react';
import { Section, Text } from 'react-email';
import { ImmichButton } from 'src/emails/components/button.component.js';
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
}: GalleryInviteEmailProps) =>
  reminder ? (
    // The reminder cannot carry the private link (only its fingerprint is kept), so it points to the invitation.
    <ImmichLayout baseUrl={baseUrl} showBranding={showBranding} preview={`A reminder about ${galleryTitle}.`}>
      <Text className="m-0">Hi {recipientName},</Text>
      <Text>
        {reminder === 'selection'
          ? `${studioName} is looking forward to your favourites from ${galleryTitle}. Your selection is due ${expiresAt ?? 'soon'}.`
          : reminder === 'payment'
            ? `Your order from ${galleryTitle} is waiting for payment, so ${studioName} can finish your photographs.`
            : `Your gallery ${galleryTitle} closes ${expiresAt ?? 'soon'}. Download or choose anything you want before then.`}
      </Text>
      <Text>Open the gallery from the link in the invitation {studioName} sent you.</Text>
    </ImmichLayout>
  ) : (
    <ImmichLayout
      baseUrl={baseUrl}
      showBranding={showBranding}
      preview={`${studioName} shared ${galleryTitle} with you.`}
    >
      <Text className="m-0">Hi {recipientName},</Text>
      <Text>
        {studioName} shared <strong>{galleryTitle}</strong> with you. Open your gallery to see the photographs and
        choose your favourites.
      </Text>
      {welcomeMessage ? <Text style={{ whiteSpace: 'pre-wrap' }}>{welcomeMessage}</Text> : null}
      <Section className="flex justify-center my-6">
        <ImmichButton href={link}>Open your gallery</ImmichButton>
      </Section>
      {expiresAt ? <Text className="text-xs">This link works until {expiresAt}.</Text> : null}
      <Text className="text-xs">
        The link is yours alone; anyone who has it can open the gallery. If {studioName} gave it a password, they will
        tell you it separately.
      </Text>
    </ImmichLayout>
  );

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
