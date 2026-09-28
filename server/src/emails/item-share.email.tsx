import { Link, Section, Text } from '@react-email/components';
import * as React from 'react';
import { ImmichButton } from 'src/emails/components/button.component.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { NO_LINK_ITEM_SHARE } from 'src/emails/components/no-link.js';
import { ItemShareEmailProps } from 'src/repositories/email.repository.js';

/**
 * FL-83 (AL-30b): items shared with a person in this library. The link opens Sharing › Shared with
 * you, at the Public server URL, else the direct-connection address or the custom hostname; without
 * one the email asks the recipient to open Frameleaf on their server (FL-190).
 */
export const ItemShareEmail = ({ baseUrl, senderName, recipientName, count, link }: ItemShareEmailProps) => {
  const items = count === 1 ? 'an item' : `${count} items`;

  return (
    <ImmichLayout baseUrl={baseUrl} preview={`${senderName} shared ${items} with you.`}>
      <Text className="m-0">
        Hey <strong>{recipientName}</strong>!
      </Text>

      <Text>
        {senderName} shared {items} with you. You can see {count === 1 ? 'it' : 'them'} in your own Frameleaf.
      </Text>

      {link ? (
        <>
          <Section className="flex justify-center my-6">
            <ImmichButton href={link}>View shared items</ImmichButton>
          </Section>

          <Text className="text-xs">
            If you cannot click the button use the link below.
            <br />
            <Link href={link}>{link}</Link>
          </Text>
        </>
      ) : (
        <Text>{NO_LINK_ITEM_SHARE}</Text>
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
