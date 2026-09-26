import { NO_LINK_ALBUM, NO_LINK_SIGN_IN, NO_LINK_TEST } from 'src/emails/components/no-link.js';
import { EmailRenderRequest, EmailRepository, EmailTemplate } from 'src/repositories/email.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { automock } from 'test/utils.js';

describe(EmailRepository.name, () => {
  let sut: EmailRepository;

  beforeEach(() => {
    // eslint-disable-next-line no-sparse-arrays
    sut = new EmailRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));
  });

  describe('renderEmail', () => {
    it('should render the email correctly for TEST_EMAIL template', async () => {
      const request: EmailRenderRequest = {
        template: EmailTemplate.TEST_EMAIL,
        data: { displayName: 'Alen Turing', baseUrl: 'http://localhost' },
        customTemplate: '',
      };

      const result = await sut.renderEmail(request);

      expect(result.html).toContain('<!DOCTYPE html PUBLIC');
      expect(result.text).toContain('test email');
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
