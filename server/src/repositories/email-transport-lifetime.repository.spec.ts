import { createTransport } from 'nodemailer';
import { EmailRepository, SendEmailResponse } from 'src/repositories/email.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { automock } from 'test/utils.js';

vi.mock('nodemailer', () => ({ createTransport: vi.fn() }));

describe('SMTP transport lifetime', () => {
  it.each(['verify', 'send'] as const)('keeps the transport open until %s succeeds', async (method) => {
    const pending = Promise.withResolvers<true | SendEmailResponse>();
    const transport = { verify: vi.fn(() => pending.promise), sendMail: vi.fn(() => pending.promise), close: vi.fn() };
    vi.mocked(createTransport).mockReturnValue(transport as unknown as ReturnType<typeof createTransport>);
    const repository = new EmailRepository(automock(LoggingRepository, { strict: false }));
    const result =
      method === 'verify'
        ? repository.verifySmtp({ host: 'smtp.example.test' })
        : repository.sendEmail({
            smtp: { host: 'smtp.example.test' },
            to: 'recipient@example.test',
            from: 'sender@example.test',
            subject: 'test',
            html: '',
            text: '',
          });
    expect(transport.close).not.toHaveBeenCalled();
    const value = method === 'verify' ? true : { messageId: 'test-id', response: 'accepted' };
    pending.resolve(value);
    await expect(result).resolves.toEqual(value);
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it.each(['verify', 'send'] as const)('closes after %s rejects and preserves its failure', async (method) => {
    const pending = Promise.withResolvers<true | SendEmailResponse>();
    const transport = { verify: vi.fn(() => pending.promise), sendMail: vi.fn(() => pending.promise), close: vi.fn() };
    vi.mocked(createTransport).mockReturnValue(transport as unknown as ReturnType<typeof createTransport>);
    const repository = new EmailRepository(automock(LoggingRepository, { strict: false }));
    const result =
      method === 'verify'
        ? repository.verifySmtp({ host: 'smtp.example.test' })
        : repository.sendEmail({
            smtp: { host: 'smtp.example.test' },
            to: 'recipient@example.test',
            from: 'sender@example.test',
            subject: 'test',
            html: '',
            text: '',
          });
    expect(transport.close).not.toHaveBeenCalled();
    const error = new Error('SMTP failed');
    const completed = expect(result).rejects.toBe(error);
    pending.reject(error);
    await completed;
    expect(transport.close).toHaveBeenCalledOnce();
  });
});
