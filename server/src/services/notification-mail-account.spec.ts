import type { FrameleafMailConnection } from 'src/types.js';
import { type SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { JobStatus, MailConnectionStatus, MailSignInProvider, MailTransportType, SystemMetadataKey } from 'src/enum.js';
import { MailApiError } from 'src/repositories/email.repository.js';
import { NotificationAdminService } from 'src/services/notification-admin.service.js';
import { NotificationService } from 'src/services/notification.service.js';
import { MailNeedsSignInError, forgetMailAccessTokens, rememberMailAccessToken } from 'src/utils/mail-connection.js';
import { userStub } from 'test/fixtures/user.stub.js';
import { type ServiceMocks, newTestService } from 'test/utils.js';

const ACCESS = 'access-token-FIXTURE-ONLY';

const configFor = (type: MailTransportType, enabled = true): SystemConfig => ({
  ...defaults,
  notifications: {
    smtp: {
      ...defaults.notifications.smtp,
      enabled,
      from: 'rivera@example.com',
      transport: { ...defaults.notifications.smtp.transport, type },
    },
  },
});

const connectionFor = (
  provider: MailSignInProvider,
  status = MailConnectionStatus.Connected,
): FrameleafMailConnection => ({
  id: 'connection-1',
  provider,
  email: 'rivera@example.com',
  status,
  sealedRefreshToken: 'sealed',
  connectedAt: '2026-10-11T10:00:00.000Z',
});

/** The saved settings and the connected account, as `system_metadata` would return them. */
const store = (mocks: ServiceMocks, config: SystemConfig, connection: FrameleafMailConnection | null) =>
  mocks.systemMetadata.get.mockImplementation((key) => {
    const values: Record<string, unknown> = {
      [SystemMetadataKey.SystemConfig]: config,
      [SystemMetadataKey.FrameleafMailConnection]: connection,
    };
    return Promise.resolve((values[key] ?? null) as never);
  });

/** FL-379: the mail job, the settings check and the test email for a connected Gmail or Microsoft account. */
describe('email through a connected account', () => {
  beforeEach(() => {
    forgetMailAccessTokens();
    rememberMailAccessToken('connection-1', ACCESS, 3600);
  });

  describe(`${NotificationService.name}.handleSendEmail`, () => {
    let sut: NotificationService;
    let mocks: ServiceMocks;
    const job = { html: '<p>hi</p>', subject: 'Hello', text: 'hi', to: 'ana@example.com' };

    beforeEach(() => {
      ({ sut, mocks } = newTestService(NotificationService));
    });

    it.each([
      [MailTransportType.Gmail, MailSignInProvider.Gmail],
      [MailTransportType.Microsoft, MailSignInProvider.Microsoft],
    ])('sends through %s instead of a mail server', async (type, provider) => {
      store(mocks, configFor(type), connectionFor(provider));
      mocks.email.sendEmailWithAccount.mockResolvedValue({ messageId: 'message-1', response: 'ok' });

      await expect(sut.handleSendEmail(job)).resolves.toBe(JobStatus.Success);

      expect(mocks.email.sendEmailWithAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          ...job,
          from: 'rivera@example.com',
          replyTo: 'rivera@example.com',
          account: { provider, accessToken: ACCESS },
        }),
      );
      expect(mocks.email.sendEmail).not.toHaveBeenCalled();
    });

    it('leaves a mail server entered by hand exactly as it was', async () => {
      store(mocks, configFor(MailTransportType.Smtp), connectionFor(MailSignInProvider.Gmail));
      mocks.email.sendEmail.mockResolvedValue({ messageId: '', response: '' });

      await expect(sut.handleSendEmail(job)).resolves.toBe(JobStatus.Success);

      expect(mocks.email.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ smtp: expect.objectContaining({ type: MailTransportType.Smtp }) }),
      );
      expect(mocks.email.sendEmailWithAccount).not.toHaveBeenCalled();
    });

    it('fails the job, rather than dropping the email, while the account needs a new sign-in', async () => {
      store(
        mocks,
        configFor(MailTransportType.Gmail),
        connectionFor(MailSignInProvider.Gmail, MailConnectionStatus.NeedsSignIn),
      );

      await expect(sut.handleSendEmail(job)).rejects.toBeInstanceOf(MailNeedsSignInError);
      expect(mocks.email.sendEmailWithAccount).not.toHaveBeenCalled();
    });

    it('fails the job when the provider refuses the message', async () => {
      store(mocks, configFor(MailTransportType.Gmail), connectionFor(MailSignInProvider.Gmail));
      mocks.email.sendEmailWithAccount.mockRejectedValue(
        new MailApiError(MailSignInProvider.Gmail, 403, 'Gmail refused (403)'),
      );
      await expect(sut.handleSendEmail(job)).rejects.toThrow('Gmail refused (403)');
    });

    it('still skips while sending is switched off', async () => {
      store(mocks, configFor(MailTransportType.Gmail, false), connectionFor(MailSignInProvider.Gmail));
      await expect(sut.handleSendEmail(job)).resolves.toBe(JobStatus.Skipped);
    });
  });

  describe(`${NotificationService.name}.onConfigValidate`, () => {
    let sut: NotificationService;
    let mocks: ServiceMocks;

    beforeEach(() => {
      ({ sut, mocks } = newTestService(NotificationService));
    });

    it('accepts Gmail once a Gmail account is connected, without checking any mail server', async () => {
      store(mocks, defaults, connectionFor(MailSignInProvider.Gmail));
      await expect(
        sut.onConfigValidate({ oldConfig: defaults, newConfig: configFor(MailTransportType.Gmail) }),
      ).resolves.not.toThrow();
      expect(mocks.email.verifySmtp).not.toHaveBeenCalled();
    });

    it('refuses a provider no account is connected for', async () => {
      store(mocks, defaults, connectionFor(MailSignInProvider.Gmail));
      await expect(
        sut.onConfigValidate({ oldConfig: defaults, newConfig: configFor(MailTransportType.Microsoft) }),
      ).rejects.toThrow('no Microsoft account is connected');
    });
  });

  describe(`${NotificationAdminService.name}.sendTestEmail`, () => {
    let sut: NotificationAdminService;
    let mocks: ServiceMocks;

    beforeEach(() => {
      ({ sut, mocks } = newTestService(NotificationAdminService));
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.email.renderEmail.mockResolvedValue({ html: '<p>test</p>', text: 'test' });
    });

    it.each([
      [MailTransportType.Gmail, MailSignInProvider.Gmail],
      [MailTransportType.Microsoft, MailSignInProvider.Microsoft],
    ])('sends the test through %s to the administrator', async (type, provider) => {
      const config = configFor(type);
      store(mocks, config, connectionFor(provider));
      mocks.email.sendEmailWithAccount.mockResolvedValue({ messageId: 'message-1', response: 'ok' });

      await expect(sut.sendTestEmail('', config.notifications.smtp)).resolves.toEqual({ messageId: 'message-1' });

      expect(mocks.email.verifySmtp).not.toHaveBeenCalled();
      expect(mocks.email.sendEmailWithAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          to: userStub.admin.email,
          subject: 'Test email from Frameleaf',
          account: { provider, accessToken: ACCESS },
        }),
      );
    });

    it('answers with the reason to sign in again', async () => {
      const config = configFor(MailTransportType.Gmail);
      store(mocks, config, connectionFor(MailSignInProvider.Gmail, MailConnectionStatus.NeedsSignIn));
      await expect(sut.sendTestEmail('', config.notifications.smtp)).rejects.toThrow(
        'Gmail is asking you to sign in again',
      );
    });

    it('answers with the provider’s own reason when it refuses the message', async () => {
      const config = configFor(MailTransportType.Microsoft);
      store(mocks, config, connectionFor(MailSignInProvider.Microsoft));
      mocks.email.sendEmailWithAccount.mockRejectedValue(
        new MailApiError(MailSignInProvider.Microsoft, 403, 'Microsoft refused (403): Access is denied'),
      );
      await expect(sut.sendTestEmail('', config.notifications.smtp)).rejects.toThrow(
        'Microsoft refused (403): Access is denied',
      );
    });
  });
});
