import { toPlainText } from '@react-email/render';
import * as React from 'react';
import { EmailMessage, useEmailText } from 'src/emails/components/email-locale.js';
import { Img, Link, Section, Text } from 'react-email';
import { ImmichButton } from 'src/emails/components/button.component.js';
import { invitationFirstLine } from 'src/emails/components/first-line.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { AlbumInviteEmailProps } from 'src/repositories/email.repository.js';
import { replaceTemplateTags } from 'src/utils/replace-template-tags.js';

export const AlbumInviteEmail = ({
  baseUrl,
  albumName,
  recipientName,
  senderName,
  albumId,
  cid,
  customTemplate,
  showBranding,
  firstLine,
}: AlbumInviteEmailProps) => {
  const t = useEmailText();
  const variables = {
    albumName,
    recipientName,
    senderName,
    albumId,
    baseUrl: baseUrl ?? '',
  };
  // FL-426: an album invitation with its own wording is sent as written, its own first line included
  const greeting = invitationFirstLine(firstLine, { recipientName, senderName });

  const emailContent = customTemplate ? (
    replaceTemplateTags(customTemplate, variables)
  ) : (
    <>
      <Text className="m-0">
        {greeting ?? (
          <>
            <EmailMessage id="greeting" values={{ name: <strong>{recipientName}</strong> }} />
          </>
        )}
      </Text>

      <Text>
        <EmailMessage id="album_invite_body" values={{ senderName, albumName: <strong>{albumName}</strong> }} />
      </Text>
    </>
  );

  return (
    <ImmichLayout
      baseUrl={baseUrl}
      showBranding={showBranding}
      preview={customTemplate ? toPlainText(emailContent.toString()) : t('album_invite_preview')}
    >
      {customTemplate && (
        <Text className="m-0">
          <div dangerouslySetInnerHTML={{ __html: emailContent }}></div>
        </Text>
      )}

      {!customTemplate && emailContent}

      {cid && (
        <Section className="flex justify-center my-0">
          <Img
            className="max-w-[300px] w-full rounded-lg"
            src={`cid:${cid}`}
            style={{
              boxShadow: 'rgba(50, 50, 93, 0.25) 0px 13px 27px -5px, rgba(0, 0, 0, 0.3) 0px 8px 16px -8px',
            }}
          />
        </Section>
      )}

      {baseUrl ? (
        <>
          <Section className="flex justify-center my-6">
            <ImmichButton href={`${baseUrl}/albums/${albumId}`}>{t('view_album')}</ImmichButton>
          </Section>

          <Text className="text-xs">
            {t('album_link_help')}
            <br />
            <Link href={`${baseUrl}/albums/${albumId}`}>{`${baseUrl}/albums/${albumId}`}</Link>
          </Text>
        </>
      ) : (
        <Text>{t('no_link_album')}</Text>
      )}
    </ImmichLayout>
  );
};

AlbumInviteEmail.PreviewProps = {
  baseUrl: 'https://photos.example.com',
  albumName: 'Trip to Europe',
  albumId: 'b63f6dae-e1c9-401b-9a85-9dbbf5612539',
  senderName: 'Owner User',
  recipientName: 'Alan Turing',
} as AlbumInviteEmailProps;

export default AlbumInviteEmail;
