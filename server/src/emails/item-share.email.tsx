import * as React from 'react';
import { EmailMessage, useEmailText } from 'src/emails/components/email-locale.js';
import { Link, Section, Text } from 'react-email';
import { ImmichButton } from 'src/emails/components/button.component.js';
import { invitationFirstLine } from 'src/emails/components/first-line.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { ItemShareEmailProps } from 'src/repositories/email.repository.js';

/**
 * FL-83 (AL-30b): items shared with a person in this library. The link opens Sharing › Shared with
 * you, at the Public server URL, else the direct-connection address or the custom hostname; without
 * one the email asks the recipient to open Frameleaf on their server (FL-190).
 */
export const ItemShareEmail = ({
  baseUrl,
  senderName,
  recipientName,
  count,
  link,
  showBranding,
  firstLine,
}: ItemShareEmailProps) => {
  const t = useEmailText();
  // FL-426: an invitation's own first line, in place of the standard greeting
  const greeting = invitationFirstLine(firstLine, { recipientName, senderName });

  return (
    <ImmichLayout
      baseUrl={baseUrl}
      showBranding={showBranding}
      preview={t(count === 1 ? 'item_share_preview_one' : 'item_share_preview_many', { senderName, count })}
    >
      <Text className="m-0">
        {greeting ?? (
          <>
            <EmailMessage id="greeting" values={{ name: <strong>{recipientName}</strong> }} />
          </>
        )}
      </Text>

      <Text>{t(count === 1 ? 'item_share_body_one' : 'item_share_body_many', { senderName, count })}</Text>

      {link ? (
        <>
          <Section className="flex justify-center my-6">
            <ImmichButton href={link}>{t('view_shared_items')}</ImmichButton>
          </Section>

          <Text className="text-xs">
            {t('link_help')}
            <br />
            <Link href={link}>{link}</Link>
          </Text>
        </>
      ) : (
        <Text>{t('no_link_item_share')}</Text>
      )}
    </ImmichLayout>
  );
};

ItemShareEmail.PreviewProps = {
  baseUrl: 'https://photos.example.com',
  senderName: 'Owner User',
  recipientName: 'Alan Turing',
  count: 3,
  link: 'https://photos.example.com/sharing?section=shared-with-you',
} as ItemShareEmailProps;

export default ItemShareEmail;
