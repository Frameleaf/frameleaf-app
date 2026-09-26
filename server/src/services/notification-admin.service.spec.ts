import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { SystemMetadataKey } from 'src/enum.js';
import { EmailTemplate } from 'src/repositories/email.repository.js';
import { NotificationAdminService } from 'src/services/notification-admin.service.js';
import { NotificationService } from 'src/services/notification.service.js';
import { userStub } from 'test/fixtures/user.stub.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const smtpTransport = Object.freeze<SystemConfig>({
  ...defaults,
  notifications: {
    smtp: {
      ...defaults.notifications.smtp,
      enabled: true,
      transport: {
        ignoreCert: false,
        host: 'localhost',
        port: 587,
        secure: false,
        username: 'test',
        password: 'test',
      },
    },
  },
});

describe(NotificationService.name, () => {
  let sut: NotificationService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(NotificationService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('sendTestEmail', () => {
    it('should throw error if user could not be found', async () => {
      await expect(sut.sendTestEmail('', smtpTransport.notifications.smtp)).rejects.toThrow('User not found');
    });

    it('should throw error if smtp validation fails', async () => {
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.email.verifySmtp.mockRejectedValue('');

      await expect(sut.sendTestEmail('', smtpTransport.notifications.smtp)).rejects.toThrow(
        'Failed to verify SMTP configuration',
      );
    });

    it('should send the email without a link when the server has no public address (FL-190)', async () => {
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.email.verifySmtp.mockResolvedValue(true);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.email.sendEmail.mockResolvedValue({ messageId: 'message-1', response: '' });

      await expect(sut.sendTestEmail('', smtpTransport.notifications.smtp)).resolves.not.toThrow();
      expect(mocks.email.renderEmail).toHaveBeenCalledWith({
        template: EmailTemplate.TEST_EMAIL,
        data: { baseUrl: undefined, displayName: userStub.admin.name },
      });
      expect(mocks.email.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Test email from Frameleaf',
          smtp: smtpTransport.notifications.smtp.transport,
        }),
      );
    });

    it('should send email to external domain', async () => {
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.email.verifySmtp.mockResolvedValue(true);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.systemMetadata.get.mockResolvedValue({ server: { externalDomain: 'https://photos.example.com' } });
      mocks.email.sendEmail.mockResolvedValue({ messageId: 'message-1', response: '' });

      await expect(sut.sendTestEmail('', smtpTransport.notifications.smtp)).resolves.not.toThrow();
      expect(mocks.email.renderEmail).toHaveBeenCalledWith({
        template: EmailTemplate.TEST_EMAIL,
        data: { baseUrl: 'https://photos.example.com', displayName: userStub.admin.name },
      });
      expect(mocks.email.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Test email from Frameleaf',
          smtp: smtpTransport.notifications.smtp.transport,
        }),
      );
    });

    it('should link to the public URL of a server linked to Frameleaf Cloud (FL-190)', async () => {
      const env = mockEnvData({});
      mocks.config.getEnv.mockReturnValue({
        ...env,
        frameleafCloud: { ...env.frameleafCloud, url: 'https://api.frameleaf.cloud' },
      });
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.email.verifySmtp.mockResolvedValue(true);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.email.sendEmail.mockResolvedValue({ messageId: 'message-1', response: '' });
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(
          (key === SystemMetadataKey.FrameleafCloudLink
            ? {
                status: 'linked',
                cloudUrl: 'https://api.frameleaf.cloud',
                instanceId: 'instance-1',
                services: {
                  relayOrigin: 'https://r.k3v9.frameleaf-direct.net',
                  publicUrl: 'https://photos.example.com/',
                },
              }
            : null) as never,
        ),
      );

      await sut.sendTestEmail('', smtpTransport.notifications.smtp);

      expect(mocks.email.renderEmail).toHaveBeenCalledWith({
        template: EmailTemplate.TEST_EMAIL,
        data: { baseUrl: 'https://photos.example.com', displayName: userStub.admin.name },
      });
    });

    it('should never link to the Frameleaf Cloud relay address (FL-190)', async () => {
      const env = mockEnvData({});
      mocks.config.getEnv.mockReturnValue({
        ...env,
        frameleafCloud: { ...env.frameleafCloud, url: 'https://api.frameleaf.cloud' },
      });
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.email.verifySmtp.mockResolvedValue(true);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.email.sendEmail.mockResolvedValue({ messageId: 'message-1', response: '' });
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(
          (key === SystemMetadataKey.FrameleafCloudLink
            ? {
                status: 'linked',
                cloudUrl: 'https://api.frameleaf.cloud',
                instanceId: 'instance-1',
                services: { relayOrigin: 'https://r.k3v9.frameleaf-direct.net' },
              }
            : null) as never,
        ),
      );

      await sut.sendTestEmail('', smtpTransport.notifications.smtp);

      expect(mocks.email.renderEmail).toHaveBeenCalledWith({
        template: EmailTemplate.TEST_EMAIL,
        data: { baseUrl: undefined, displayName: userStub.admin.name },
      });
    });

    it('should never link to a Frameleaf Cloud address while the server is not linked (FL-190)', async () => {
      const env = mockEnvData({});
      mocks.config.getEnv.mockReturnValue({
        ...env,
        frameleafCloud: { ...env.frameleafCloud, url: 'https://api.frameleaf.cloud' },
      });
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.email.verifySmtp.mockResolvedValue(true);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.email.sendEmail.mockResolvedValue({ messageId: 'message-1', response: '' });
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(
          (key === SystemMetadataKey.FrameleafCloudLink
            ? {
                status: 'revoked',
                cloudUrl: 'https://api.frameleaf.cloud',
                services: { publicUrl: 'https://photos.example.com' },
              }
            : null) as never,
        ),
      );

      await sut.sendTestEmail('', smtpTransport.notifications.smtp);

      expect(mocks.email.renderEmail).toHaveBeenCalledWith({
        template: EmailTemplate.TEST_EMAIL,
        data: { baseUrl: undefined, displayName: userStub.admin.name },
      });
    });

    it('should send email with replyTo', async () => {
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.email.verifySmtp.mockResolvedValue(true);
      mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
      mocks.email.sendEmail.mockResolvedValue({ messageId: 'message-1', response: '' });

      await expect(
        sut.sendTestEmail('', { ...smtpTransport.notifications.smtp, replyTo: 'demo@example.com' }),
      ).resolves.not.toThrow();
      expect(mocks.email.renderEmail).toHaveBeenCalledWith({
        template: EmailTemplate.TEST_EMAIL,
        data: { baseUrl: undefined, displayName: userStub.admin.name },
      });
      expect(mocks.email.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Test email from Frameleaf',
          smtp: smtpTransport.notifications.smtp.transport,
          replyTo: 'demo@example.com',
        }),
      );
    });
  });
});

describe(`${NotificationAdminService.name} test email with a write-only password (FL-67)`, () => {
  let sut: NotificationAdminService;
  let mocks: ServiceMocks;

  const stored = smtpTransport.notifications.smtp.transport;
  const redactedDraft = { ...smtpTransport.notifications.smtp, transport: { ...stored, password: '' } };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(NotificationAdminService));
    mocks.user.get.mockResolvedValue(userStub.admin);
    mocks.email.verifySmtp.mockResolvedValue(true);
    mocks.email.renderEmail.mockResolvedValue({ html: '', text: '' });
    mocks.email.sendEmail.mockResolvedValue({ messageId: 'message-1', response: '' });
    mocks.systemMetadata.get.mockResolvedValue({ notifications: { smtp: { transport: stored } } });
  });

  it('should use the stored password for the stored server when the draft carries none', async () => {
    await sut.sendTestEmail('', redactedDraft);

    expect(mocks.email.verifySmtp).toHaveBeenCalledWith(expect.objectContaining({ password: 'test' }));
    expect(mocks.email.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ smtp: expect.objectContaining({ password: 'test' }) }),
    );
  });

  it('should never send the stored password to a different server', async () => {
    await sut.sendTestEmail('', { ...redactedDraft, transport: { ...redactedDraft.transport, host: 'elsewhere' } });

    expect(mocks.email.verifySmtp).toHaveBeenCalledWith(expect.objectContaining({ host: 'elsewhere', password: '' }));
  });

  it('should never send the stored password to a different account or security mode', async () => {
    await sut.sendTestEmail('', { ...redactedDraft, transport: { ...redactedDraft.transport, username: 'other' } });
    await sut.sendTestEmail('', { ...redactedDraft, transport: { ...redactedDraft.transport, ignoreCert: true } });

    for (const [transport] of mocks.email.verifySmtp.mock.calls) {
      expect(transport.password).toBe('');
    }
  });

  it('should use a password typed into the draft as it is', async () => {
    await sut.sendTestEmail('', { ...redactedDraft, transport: { ...redactedDraft.transport, password: 'typed' } });

    expect(mocks.email.verifySmtp).toHaveBeenCalledWith(expect.objectContaining({ password: 'typed' }));
  });
});
