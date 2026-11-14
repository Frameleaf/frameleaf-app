import * as React from 'react';
import { Text } from 'react-email';
import { ImmichButton } from 'src/emails/components/button.component.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';

export type ContractEmailProps = {
  studioName: string;
  color: string;
  heading: string;
  body: string;
  button?: string;
  url?: string;
};
export const PhotographyContractEmail = ({ studioName, color, heading, body, button, url }: ContractEmailProps) => (
  <ImmichLayout preview={heading} showBranding={false}>
    <Text style={{ color, fontSize: 22, fontWeight: 600 }}>{studioName}</Text>
    <Text style={{ fontSize: 18, fontWeight: 600 }}>{heading}</Text>
    <Text>{body}</Text>
    {button && url && <ImmichButton href={url}>{button}</ImmichButton>}
  </ImmichLayout>
);

export default PhotographyContractEmail;
