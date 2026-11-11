import * as React from 'react';
import { useEmailText } from 'src/emails/components/email-locale.js';
import { Section, Text } from 'react-email';
import type { NewSignInEmailProps } from 'src/repositories/email.repository.js';
import { ImmichButton } from 'src/emails/components/button.component.js';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { SIGN_IN_SECURITY_URL } from 'src/utils/sign-in-security.js';

export const NewSignInEmail = ({ baseUrl, showBranding, ...data }: NewSignInEmailProps) => {
  const t = useEmailText();
  return (
    <ImmichLayout
      baseUrl={baseUrl}
      showBranding={showBranding}
      preview={t(data.kind === 'new-device' ? 'new_sign_in_title' : 'sign_in_failure_title')}
    >
      {data.kind === 'new-device' ? (
        <>
          <Text>{t('new_sign_in_body')}</Text>
          <Text>
            {t('device', { device: data.device })}
            <br />
            {t('place', { place: data.place })}
            <br />
            {t('time', { time: data.time })}
          </Text>
        </>
      ) : (
        <Text>{t('sign_in_attempts_body')}</Text>
      )}
      <Text>{t('sign_in_warning')}</Text>
      {baseUrl && (
        <Section className="my-6">
          <ImmichButton href={`${baseUrl}${SIGN_IN_SECURITY_URL}`}>{t('this_wasnt_me')}</ImmichButton>
        </Section>
      )}
    </ImmichLayout>
  );
};
