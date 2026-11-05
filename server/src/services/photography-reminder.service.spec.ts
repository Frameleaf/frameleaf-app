import type { PhotographyWorkflow } from 'src/services/photography-workflow.service.js';
import { JobName } from 'src/enum.js';
import { PhotographyReminderService, accessCloses, dueReminders } from 'src/services/photography-reminder.service.js';
import * as configUtils from 'src/utils/config.js';

const now = new Date('2026-11-04T10:00:00Z');
const recipient = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  email: `${id}@example.com`,
  tokenHash: '',
  passwordHash: null,
  revoked: false,
  expiresAt: null,
  canProof: true,
  canDownload: false,
  captureIds: null,
  choices: [],
  notes: {},
  ...extra,
});
const workflow = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    config: { title: 'An afternoon together', reminders: { selection: true, paymentAndExpiry: true }, ...config },
    recipients: [recipient('jamie')],
    rounds: [],
    orders: [],
    ...extra,
  }) as unknown as PhotographyWorkflow;

describe('dueReminders', () => {
  it('reminds a client who has not chosen two days before the selection deadline, once', () => {
    const value = workflow({ selectionDeadline: '2026-11-06T23:59:59Z', expiresAt: null });
    expect(dueReminders(value, now)).toEqual([
      { kind: 'selection', email: 'jamie@example.com', name: 'jamie', date: '2026-11-06T23:59:59Z' },
    ]);
    expect(dueReminders(value, new Date('2026-11-05T10:00:00Z'))).toEqual([]);
    expect(dueReminders(value, new Date('2026-11-03T10:00:00Z'))).toEqual([]);
  });

  it('leaves out a client who already sent a selection, has no email, or was revoked', () => {
    const config = { selectionDeadline: '2026-11-06T23:59:59Z', expiresAt: null };
    expect(dueReminders(workflow(config, { rounds: [{ recipientId: 'jamie' }] }), now)).toEqual([]);
    expect(dueReminders(workflow(config, { recipients: [recipient('jamie', { email: undefined })] }), now)).toEqual([]);
    expect(dueReminders(workflow(config, { recipients: [recipient('jamie', { revoked: true })] }), now)).toEqual([]);
  });

  it('reminds about an unpaid order three days on and the gallery closing three days ahead', () => {
    const value = workflow(
      { selectionDeadline: null, expiresAt: '2026-11-07T23:59:59Z' },
      {
        orders: [
          { recipientId: 'jamie', status: 'quoted', total: 2500, createdAt: '2026-11-01T09:00:00Z' },
          { recipientId: 'jamie', status: 'settled', total: 2500, createdAt: '2026-11-01T09:00:00Z' },
        ],
      },
    );
    expect(dueReminders(value, now).map(({ kind }) => kind)).toEqual(['payment', 'expiry']);
  });

  it('counts down to the gallery closing when it closes before the client’s own link', () => {
    const value = workflow(
      { selectionDeadline: null, expiresAt: '2026-11-07T23:59:59Z' },
      { recipients: [recipient('jamie', { expiresAt: '2026-12-31T23:59:59Z' })] },
    );
    expect(dueReminders(value, now)).toEqual([
      expect.objectContaining({ kind: 'expiry', date: '2026-11-07T23:59:59Z' }),
    ]);
    expect(accessCloses('2026-12-31T23:59:59Z', '2026-11-07T23:59:59Z')).toBe('2026-11-07T23:59:59Z');
    expect(accessCloses('2026-11-01T00:00:00Z', null)).toBe('2026-11-01T00:00:00Z');
    expect(accessCloses(null, null)).toBeNull();
  });

  it('sends nothing when the reminders are off', () => {
    const value = workflow(
      { selectionDeadline: '2026-11-06T23:59:59Z', expiresAt: '2026-11-07T23:59:59Z', reminders: undefined },
      { orders: [{ recipientId: 'jamie', status: 'quoted', total: 2500, createdAt: '2026-11-01T09:00:00Z' }] },
    );
    expect(dueReminders(value, now)).toEqual([]);
  });
});

describe(PhotographyReminderService.name, () => {
  const setup = (smtp: boolean) => {
    const value = workflow({ selectionDeadline: '2026-11-06T23:59:59Z', expiresAt: null });
    const repository = {
      remindable: vi.fn().mockResolvedValue([{ id: 'w1', ownerId: 'owner', value }]),
      ownerName: vi.fn().mockResolvedValue('Taylor'),
    };
    const workspace = { get: vi.fn().mockResolvedValue({ value: { brand: { name: 'Cedar & Light' } } }) };
    const email = { renderEmail: vi.fn().mockResolvedValue({ html: '<p/>', text: 'text' }) };
    const jobs = { queue: vi.fn() };
    const logger = { setContext: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() };
    const sut = new PhotographyReminderService(
      repository as never,
      workspace as never,
      email as never,
      jobs as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      logger as never,
    );
    vi.spyOn(configUtils, 'getConfig').mockResolvedValue({
      server: { externalDomain: 'https://photos.example.com' },
      notifications: { smtp: { enabled: smtp } },
      templates: { email: { showBranding: true } },
    } as never);
    return { sut, email, jobs };
  };

  it('queues each due reminder as an email from the studio', async () => {
    const { sut, email, jobs } = setup(true);
    await expect(sut.sendReminders(now)).resolves.toBe(1);
    expect(email.renderEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reminder: 'selection', studioName: 'Cedar & Light', recipientName: 'jamie' }),
      }),
    );
    expect(jobs.queue).toHaveBeenCalledWith({
      name: JobName.SendMail,
      data: expect.objectContaining({ to: 'jamie@example.com', subject: expect.stringContaining('favourites') }),
    });
  });

  it('sends nothing while email is off', async () => {
    const { sut, jobs } = setup(false);
    await expect(sut.sendReminders(now)).resolves.toBe(0);
    expect(jobs.queue).not.toHaveBeenCalled();
  });
});
