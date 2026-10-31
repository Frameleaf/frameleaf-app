import { render as renderComponent, toPlainText } from '@react-email/render';
import { createTransport } from 'nodemailer';
import { NO_LINK_ALBUM, NO_LINK_SIGN_IN, NO_LINK_TEST } from 'src/emails/components/no-link.js';
import { EmailRenderRequest, EmailRepository, EmailTemplate } from 'src/repositories/email.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { automock } from 'test/utils.js';

vi.mock('@react-email/render', async (original) => {
  const renderer = await original<typeof import('@react-email/render')>();
  return { ...renderer, render: vi.fn(renderer.render) };
});

vi.mock('nodemailer', async (original) => {
  const mailer = await original<typeof import('nodemailer')>();
  return { ...mailer, createTransport: vi.fn(mailer.createTransport) };
});

describe(EmailRepository.name, () => {
  let sut: EmailRepository;

  beforeEach(() => {
    vi.mocked(renderComponent).mockClear();
    // eslint-disable-next-line no-sparse-arrays
    sut = new EmailRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));
  });

  describe('sendEmail', () => {
    it.each(['replies@example.com', undefined])('preserves reply-to %s in SMTP MIME', async (replyTo) => {
      const transport = createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
      const close = vi.spyOn(transport, 'close');
      const send = vi.spyOn(transport, 'sendMail');
      vi.mocked(createTransport).mockReturnValueOnce(transport);
      await sut.sendEmail({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        replyTo,
        subject: 'Fixture',
        html: '<p>Fixture</p>',
        text: 'Fixture',
        smtp: { host: 'unused.example.com' },
      });
      const mime = (await send.mock.results[0].value).message.toString();
      if (replyTo) {
        expect(mime).toContain(`Reply-To: ${replyTo}\r\n`);
      } else {
        expect(mime).not.toContain('Reply-To:');
      }
      expect(close).toHaveBeenCalledOnce();
    });
  });

  describe('renderEmail', () => {
    it('renders the component once and derives matching plain text from the same HTML', async () => {
      const result = await sut.renderEmail({
        template: EmailTemplate.TEST_EMAIL,
        data: { displayName: 'Ada' },
        customTemplate: '',
      });
      expect(renderComponent).toHaveBeenCalledOnce();
      expect(result.text).toBe(toPlainText(result.html));
    });

    it('does not double-encode custom previews', async () => {
      for (const request of [
        {
          template: EmailTemplate.WELCOME,
          data: { displayName: 'Ada & Bob', username: 'user' },
          customTemplate: '<strong>{displayName}</strong>',
        },
        {
          template: EmailTemplate.ALBUM_INVITE,
          data: { albumName: 'Ada & Bob', albumId: 'album', senderName: 'Ada', recipientName: 'Jane' },
          customTemplate: '<strong>{albumName}</strong>',
        },
        {
          template: EmailTemplate.ALBUM_UPDATE,
          data: { albumName: 'Ada & Bob', albumId: 'album', recipientName: 'Jane' },
          customTemplate: '<strong>{albumName}</strong>',
        },
      ] as EmailRenderRequest[]) {
        const { html, text } = await sut.renderEmail(request);
        expect(html).not.toContain('&amp;amp;');
        expect(html).not.toContain('&lt;strong&gt;');
        expect(text).toContain('Ada & Bob');
      }
    });

    it('keeps custom markup while treating variables as text in all three template consumers', async () => {
      const value = '<img src="https://attacker.example/pixel"> & "';
      for (const request of [
        {
          template: EmailTemplate.WELCOME,
          data: { displayName: value, username: 'user' },
          customTemplate: '<strong>{displayName}</strong>',
        },
        {
          template: EmailTemplate.ALBUM_INVITE,
          data: { albumName: value, albumId: 'album', senderName: value, recipientName: 'Jane' },
          customTemplate: '<strong>{senderName}: {albumName}</strong>',
        },
        {
          template: EmailTemplate.ALBUM_UPDATE,
          data: { albumName: value, albumId: 'album', recipientName: 'Jane' },
          customTemplate: '<strong>{albumName}</strong>',
        },
      ] as EmailRenderRequest[]) {
        const { html, text } = await sut.renderEmail(request);
        expect(html).toContain('<strong>');
        expect(html).not.toContain('src="https://attacker.example/pixel"');
        expect(text).toContain(value);
      }
    });

    it('should render the email correctly for TEST_EMAIL template', async () => {
      const request: EmailRenderRequest = {
        template: EmailTemplate.TEST_EMAIL,
        data: { displayName: 'Alen Turing', baseUrl: 'http://localhost' },
        customTemplate: '',
      };

      const result = await sut.renderEmail(request);

      expect(result.html).toContain('<!DOCTYPE html PUBLIC');
      expect(result.text).toContain('test email');
      expect(result.html).toContain('font-size:16px');
      expect(result.html).toContain('padding:48px');
      expect(result.html).toContain('Overpass');
      expect(result.html).toContain('Frameleaf');
    });

    it('should serve the Frameleaf header logo from the configured server origin', async () => {
      const result = await sut.renderEmail({
        template: EmailTemplate.TEST_EMAIL,
        data: { displayName: 'Alen Turing', baseUrl: 'https://photos.example.com/' },
        customTemplate: '',
      });

      expect(result.html).toContain('src="https://photos.example.com/frameleaf/frameleaf-logo-light.png"');
      expect(result.html).toContain('alt="Frameleaf"');
      expect(result.html).not.toContain('immich-logo');
      expect(result.html).not.toContain('raw.githubusercontent.com');
    });

    it('should not use Immich as the product name or link app-store badges', async () => {
      for (const request of [
        { template: EmailTemplate.TEST_EMAIL, data: { displayName: 'Alen Turing', baseUrl: 'http://localhost' } },
        {
          template: EmailTemplate.WELCOME,
          data: { displayName: 'Alen Turing', username: 'turing', baseUrl: 'http://localhost' },
        },
      ] as EmailRenderRequest[]) {
        const { html, text } = await sut.renderEmail({ ...request, customTemplate: '' });

        for (const output of [html, text]) {
          expect(output).not.toMatch(/immich/i);
          expect(output).not.toContain('play.google.com');
          expect(output).not.toContain('apps.apple.com');
        }
        expect(text).toContain('Frameleaf');
      }
    });

    it('should send no link, and say to open Frameleaf, when the server has no public address (FL-190)', async () => {
      const album = { albumName: 'Holiday', albumId: '123', recipientName: 'Jane' };
      for (const [request, notice] of [
        [{ template: EmailTemplate.TEST_EMAIL, data: { displayName: 'Alen Turing' } }, NO_LINK_TEST],
        [
          { template: EmailTemplate.WELCOME, data: { displayName: 'Alen Turing', username: 'turing' } },
          NO_LINK_SIGN_IN,
        ],
        [{ template: EmailTemplate.ALBUM_INVITE, data: { ...album, senderName: 'John' } }, NO_LINK_ALBUM],
        [{ template: EmailTemplate.ALBUM_UPDATE, data: album }, NO_LINK_ALBUM],
      ] as [EmailRenderRequest, string][]) {
        const { html, text } = await sut.renderEmail({ ...request, customTemplate: '' });

        expect(text).toContain(notice);
        expect(html).not.toContain('href=');
        expect(html).not.toContain('undefined');
        expect(html).not.toMatch(/immich/i);
        expect(html).not.toContain('frameleaf-logo-light.png');
        expect(text).toContain('Frameleaf');
      }
    });

    it('should drop the {baseUrl} tag from a custom template when the server has no public address (FL-190)', async () => {
      const { html, text } = await sut.renderEmail({
        template: EmailTemplate.ALBUM_INVITE,
        data: { albumName: 'Holiday', albumId: '123', recipientName: 'Jane', senderName: 'John' },
        customTemplate: '{senderName} shared {albumName}: {baseUrl}/albums/{albumId}',
      });

      expect(text).toContain('John shared Holiday: /albums/123');
      expect(html).not.toContain('{baseUrl}');
      expect(text).toContain(NO_LINK_ALBUM);
    });

    describe('the emails themselves (FL-426)', () => {
      const invite = {
        albumName: 'Holiday',
        albumId: '123',
        recipientName: 'Jane',
        senderName: 'John',
        baseUrl: 'https://photos.example.com',
      };

      it('leaves the Frameleaf name and logo off the top of every email when turned off', async () => {
        for (const request of [
          { template: EmailTemplate.TEST_EMAIL, data: { displayName: 'Jane', baseUrl: invite.baseUrl } },
          { template: EmailTemplate.WELCOME, data: { displayName: 'Jane', username: 'jane', baseUrl: invite.baseUrl } },
          { template: EmailTemplate.ALBUM_INVITE, data: invite },
          { template: EmailTemplate.ALBUM_UPDATE, data: invite },
          { template: EmailTemplate.ITEM_SHARE, data: { ...invite, count: 2, link: `${invite.baseUrl}/sharing` } },
        ] as EmailRenderRequest[]) {
          const shown = await sut.renderEmail({ ...request, customTemplate: '' } as EmailRenderRequest);
          expect(shown.html).toContain('frameleaf-logo-light.png');

          const hidden = await sut.renderEmail({
            ...request,
            data: { ...request.data, showBranding: false },
            customTemplate: '',
          } as EmailRenderRequest);
          expect(hidden.html).not.toContain('frameleaf-logo-light.png');
          expect(hidden.html).not.toContain('alt="Frameleaf"');
        }

        const noAddress = await sut.renderEmail({
          template: EmailTemplate.TEST_EMAIL,
          data: { displayName: 'Jane', showBranding: false },
          customTemplate: '',
        });
        expect(noAddress.html).not.toContain('text-2xl');
      });

      it('opens an invitation with its own first line, as plain text with the names filled in', async () => {
        const firstLine = 'Hi {recipientName}, <b>{senderName}</b> has  something\nfor you';
        for (const request of [
          { template: EmailTemplate.ALBUM_INVITE, data: { ...invite, firstLine } },
          { template: EmailTemplate.ITEM_SHARE, data: { ...invite, count: 1, firstLine } },
        ] as EmailRenderRequest[]) {
          const { html, text } = await sut.renderEmail({ ...request, customTemplate: '' });
          expect(text).toContain('Hi Jane, <b>John</b> has something for you');
          expect(html).toContain('&lt;b&gt;John&lt;/b&gt;');
          expect(text).not.toContain('Hey Jane!');
        }
      });

      it('keeps the standard greeting without a first line, and an own invitation wording as written', async () => {
        const standard = await sut.renderEmail({
          template: EmailTemplate.ALBUM_INVITE,
          data: { ...invite, firstLine: ' \n ' },
          customTemplate: '',
        });
        expect(standard.text).toContain('Hey Jane!');

        const own = await sut.renderEmail({
          template: EmailTemplate.ALBUM_INVITE,
          data: { ...invite, firstLine: 'Hi there' },
          customTemplate: 'Dear {recipientName}, see {albumName}',
        });
        expect(own.text).toContain('Dear Jane, see Holiday');
        expect(own.text).not.toContain('Hi there');
      });
    });

    it('should render the email correctly for WELCOME template', async () => {
      const request: EmailRenderRequest = {
        template: EmailTemplate.WELCOME,
        data: { displayName: 'Alen Turing', username: 'turing', baseUrl: 'http://localhost' },
        customTemplate: '',
      };

      const result = await sut.renderEmail(request);

      expect(result.html).toContain('<!DOCTYPE html PUBLIC');
      expect(result.text).toContain('A new account has been created for you');
    });

    it('should render the email correctly for ALBUM_INVITE template', async () => {
      const request: EmailRenderRequest = {
        template: EmailTemplate.ALBUM_INVITE,
        data: {
          albumName: 'Vacation',
          albumId: '123',
          senderName: 'John',
          recipientName: 'Jane',
          baseUrl: 'http://localhost',
        },
        customTemplate: '',
      };

      const result = await sut.renderEmail(request);

      expect(result.html).toContain('<!DOCTYPE html PUBLIC');
      expect(result.text).toContain('Vacation');
    });

    it('should render the email correctly for ALBUM_UPDATE template', async () => {
      const request: EmailRenderRequest = {
        template: EmailTemplate.ALBUM_UPDATE,
        data: { albumName: 'Holiday', albumId: '123', recipientName: 'Jane', baseUrl: 'http://localhost' },
        customTemplate: '',
      };

      const result = await sut.renderEmail(request);

      expect(result.html).toContain('<!DOCTYPE html PUBLIC');
      expect(result.text).toContain('Holiday');
    });
  });
});
