import { render } from '@react-email/render';
import { createElement } from 'react';
import { EmailLocaleContext, emailText } from 'src/emails/components/email-locale.js';
import MiniSessionEmail from 'src/emails/photography-mini-session.email.js';
import PrintSaleEmail from 'src/emails/photography-print-sale.email.js';
import ReviewRequestEmail from 'src/emails/photography-review-request.email.js';

it.each([PrintSaleEmail, ReviewRequestEmail, MiniSessionEmail])(
  'escapes campaign content and renders the studio unsubscribe link',
  async (template) => {
    const html = await render(
      createElement(
        EmailLocaleContext.Provider,
        { value: 'fr' },
        createElement(template, {
          studioName: 'Studio & Co',
          subject: 'Your prints',
          body: '<script>alert(1)</script>',
          color: '#123456',
          unsubscribeUrl: 'https://photos.example.test/api/photography/unsubscribe/fixture',
        }),
      ),
    );
    expect(html).toContain('Studio &amp; Co');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Se désabonner');
    expect(html).toContain('https://photos.example.test/api/photography/unsubscribe/fixture');
  },
);
it.each(['en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'sv', 'da', 'nb-NO'])(
  'has localized unsubscribe messages for %s',
  (locale) => {
    expect(emailText(locale, 'campaign_unsubscribe')).toBeTruthy();
    expect(emailText(locale, 'campaign_unsubscribed')).toBeTruthy();
    if (locale !== 'en')
      expect(emailText(locale, 'campaign_unsubscribed')).not.toBe(emailText('en', 'campaign_unsubscribed'));
  },
);
