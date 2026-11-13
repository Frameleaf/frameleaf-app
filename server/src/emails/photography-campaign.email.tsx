import * as React from 'react';
import { Link, Text } from 'react-email';
import { useEmailText } from 'src/emails/components/email-locale.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';

export type CampaignEmailProps = {
  studioName: string;
  subject: string;
  body: string;
  unsubscribeUrl: string;
  color: string;
};
export const PhotographyCampaignEmail = ({ studioName, subject, body, unsubscribeUrl, color }: CampaignEmailProps) => {
  const t = useEmailText();
  return (
    <ImmichLayout preview={subject} showBranding={false}>
      <Text style={{ color, fontSize: 22, fontWeight: 600 }}>{studioName}</Text>
      <Text style={{ fontSize: 18, fontWeight: 600 }}>{subject}</Text>
      <Text style={{ whiteSpace: 'pre-wrap' }}>{body}</Text>
      <Text>
        {studioName} · <Link href={unsubscribeUrl}>{t('campaign_unsubscribe')}</Link>
      </Text>
    </ImmichLayout>
  );
};
