import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotographyCampaignSaveDto } from 'src/dtos/photography-campaign.dto.js';
import { MailSignInProvider } from 'src/enum.js';
import { MailApiError } from 'src/repositories/email.repository.js';
import { PhotographyCampaignService } from 'src/services/photography-campaign.service.js';
import { MailNeedsSignInError } from 'src/utils/mail-connection.js';
import { factory } from 'test/small.factory.js';
import { newTestService } from 'test/utils.js';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));
describe(PhotographyCampaignService.name, () => {
  let sut: PhotographyCampaignService;
  const campaigns = {
    get: vi.fn(),
    reserveTest: vi.fn(),
    schedule: vi.fn(),
    due: vi.fn(),
    claim: vi.fn(),
    sendIfEligible: vi.fn(),
    finish: vi.fn(),
    complete: vi.fn(),
    pause: vi.fn(),
  };
  const send = vi.fn();
  const message = vi.fn();
  const delivery = vi.fn();
  const auth = factory.auth({ session: {} });
  beforeEach(() => {
    vi.resetAllMocks();
    sut = newTestService(PhotographyCampaignService).sut;
    Object.assign(sut, {
      campaigns,
      send,
      message,
      delivery,
      workflow: {
        studioOwner: (candidate: typeof auth) => {
          if (!candidate.session || candidate.apiKey || candidate.sharedLink) throw new ForbiddenException();
          return candidate.user.id;
        },
      },
    });
    campaigns.get.mockResolvedValue({ id: 'campaign', ownerId: auth.user.id, subject: 'Photos', scheduledFor: null });
    campaigns.reserveTest.mockResolvedValue(true);
    delivery.mockResolvedValue({ ready: true });
    message.mockResolvedValue({ delivery: { ready: true }, owner: { email: 'studio@example.test' } });
    send.mockResolvedValue({ messageId: 'accepted' });
  });
  it('sends tests only to the studio address resolved on the server', async () => {
    await sut.test(auth, 'campaign');
    expect(send).toHaveBeenCalledWith(expect.anything(), 'studio@example.test', 'Photos');
    expect(campaigns.get).toHaveBeenCalledWith(auth.user.id, 'campaign');
  });
  it('blocks a disconnected sender and throttles repeated tests before transport', async () => {
    message.mockResolvedValueOnce({ delivery: { ready: false }, owner: { email: 'studio@example.test' } });
    await expect(sut.test(auth, 'campaign')).rejects.toBeInstanceOf(BadRequestException);
    campaigns.reserveTest.mockResolvedValueOnce(false);
    await expect(sut.test(auth, 'campaign')).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });
  it('requires a studio session before accessing a campaign', async () => {
    await expect(sut.test({ ...auth, session: undefined }, 'campaign')).rejects.toBeInstanceOf(ForbiddenException);
    expect(campaigns.get).not.toHaveBeenCalled();
  });
  it('rechecks opt-outs immediately before transport and keeps uncertain attempts for review', async () => {
    campaigns.due.mockResolvedValue([{ id: 'campaign', ownerId: auth.user.id }]);
    campaigns.claim
      .mockResolvedValueOnce({ id: 'opt-out', email: 'first@example.test' })
      .mockResolvedValueOnce({ id: 'uncertain', email: 'second@example.test' })
      .mockResolvedValue(undefined);
    campaigns.sendIfEligible
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async (_id: string, _contact: string, sendMail: () => Promise<unknown>) => {
        await sendMail();
        return true;
      });
    send.mockRejectedValue(new Error('Connection interrupted after handoff'));
    await sut.dispatch();
    expect(send).toHaveBeenCalledTimes(1);
    expect(campaigns.finish).toHaveBeenCalledExactlyOnceWith('campaign', 'opt-out', 'unsubscribed');
    expect(campaigns.pause).toHaveBeenCalledWith('campaign', 60);
    expect(campaigns.complete).not.toHaveBeenCalled();
  });
  it.each([600, 172_800])(
    'honors provider backoff of %i seconds and leaves later recipients pending',
    async (delay) => {
      campaigns.due.mockResolvedValue([{ id: 'campaign', ownerId: auth.user.id }]);
      campaigns.claim.mockResolvedValueOnce({ id: 'client', email: 'client@example.test' });
      campaigns.sendIfEligible.mockImplementationOnce(
        async (_id: string, _contact: string, sendMail: () => Promise<unknown>) => {
          await sendMail();
          return true;
        },
      );
      send.mockRejectedValue(new MailApiError(MailSignInProvider.Gmail, 429, 'Slow down', delay));
      await sut.dispatch();
      expect(campaigns.pause).toHaveBeenCalledWith('campaign', delay);
      expect(campaigns.finish).toHaveBeenCalledWith('campaign', 'client', 'pending');
      expect(campaigns.claim).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps an untouched recipient pending if the mail account disconnects before transport', async () => {
    campaigns.due.mockResolvedValue([{ id: 'campaign', ownerId: auth.user.id }]);
    campaigns.claim.mockResolvedValueOnce({ id: 'client', email: 'client@example.test' });
    message.mockResolvedValueOnce({ delivery: { ready: false } });
    await sut.dispatch();
    expect(campaigns.finish).toHaveBeenCalledWith('campaign', 'client', 'pending');
    expect(campaigns.sendIfEligible).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('returns an untouched recipient to pending when preparing the message fails', async () => {
    campaigns.due.mockResolvedValue([{ id: 'campaign', ownerId: auth.user.id }]);
    campaigns.claim.mockResolvedValueOnce({ id: 'client', email: 'client@example.test' });
    message.mockRejectedValueOnce(new Error('Metadata unavailable'));
    await expect(sut.dispatch()).rejects.toThrow('Metadata unavailable');
    expect(campaigns.finish).toHaveBeenCalledWith('campaign', 'client', 'pending');
    expect(campaigns.sendIfEligible).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    [new MailApiError(MailSignInProvider.Gmail, 401, 'Authentication refused'), 'pending'],
    [
      new MailApiError(MailSignInProvider.Gmail, 403, 'Permission refused', undefined, 'insufficientPermissions'),
      'pending',
    ],
    [
      new MailApiError(MailSignInProvider.Microsoft, 403, 'Permission refused', undefined, 'ErrorAccessDenied'),
      'pending',
    ],
    [new MailNeedsSignInError(MailSignInProvider.Gmail), 'pending'],
    [new MailApiError(MailSignInProvider.Gmail, 403, 'Domain policy', undefined, 'domainPolicy'), 'failed'],
    [new MailApiError(MailSignInProvider.Microsoft, 408, 'Timeout'), undefined],
  ] as const)(
    'classifies a confirmed account refusal without replaying ambiguous transport (%s)',
    async (error, status) => {
      campaigns.due.mockResolvedValue([{ id: 'campaign', ownerId: auth.user.id }]);
      campaigns.claim.mockResolvedValueOnce({ id: 'client', email: 'client@example.test' });
      campaigns.sendIfEligible.mockImplementationOnce(
        async (_id: string, _contact: string, sendMail: () => Promise<unknown>) => {
          await sendMail();
          return true;
        },
      );
      send.mockRejectedValueOnce(error);
      await sut.dispatch();
      if (status) expect(campaigns.finish).toHaveBeenCalledWith('campaign', 'client', status);
      else expect(campaigns.finish).not.toHaveBeenCalled();
      expect(campaigns.pause).toHaveBeenCalledWith('campaign', 60);
    },
  );
  it('rejects header injection and oversized custom messages', () => {
    const row = {
      name: 'Photos',
      templateKey: 'print-sale',
      subject: 'Hi\r\nBcc: other@example.test',
      body: 'Hello',
      audience: { source: 'clients' },
    };
    expect(PhotographyCampaignSaveDto.schema.safeParse(row).success).toBe(false);
    expect(
      PhotographyCampaignSaveDto.schema.safeParse({ ...row, subject: 'Photos', body: 'x'.repeat(10_001) }).success,
    ).toBe(false);
  });
});
