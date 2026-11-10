import { toAccountEventVia, toIpPrefix } from 'src/repositories/account-event.repository.js';
import { ACCOUNT_EVENT_RETENTION_DAYS, AccountEventService } from 'src/services/account-event.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { newUuid, newUuidV7 } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: newUuidV7(),
  userId: newUuid(),
  sessionId: null,
  action: 'signed-in',
  subject: 'Taylor',
  detail: 'password',
  ipPrefix: '203.0.113.0/24',
  deviceType: 'Safari',
  deviceOS: 'iOS',
  via: 'home',
  createdAt: new Date('2026-11-01T10:00:00.000Z'),
  ...overrides,
});

describe(AccountEventService.name, () => {
  let sut: AccountEventService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AccountEventService));
  });

  describe('getMine', () => {
    it('reads only the caller’s rows and says whether an older page exists', async () => {
      const auth = AuthFactory.create();
      const rows = [row(), row(), row()];
      mocks.accountEvent.getByUserId.mockResolvedValue(rows);

      const result = await sut.getMine(auth, { take: 2 });

      expect(mocks.accountEvent.getByUserId).toHaveBeenCalledWith(auth.user.id, { before: undefined, take: 3 });
      expect(result.hasMore).toBe(true);
      expect(result.events).toHaveLength(2);
      expect(result.events[0]).toEqual({
        id: rows[0].id,
        source: 'account',
        userId: rows[0].userId,
        action: 'signed-in',
        subject: 'Taylor',
        detail: 'password',
        ipPrefix: '203.0.113.0/24',
        deviceType: 'Safari',
        deviceOS: 'iOS',
        via: 'home',
        actorId: null,
        actorName: null,
        createdAt: '2026-11-01T10:00:00.000Z',
      });
    });
  });

  describe('getAll', () => {
    it('passes the filters and keeps admin rows tagged', async () => {
      const userId = newUuid();
      mocks.accountEvent.getAll.mockResolvedValue([
        { ...row(), source: 'admin' as const, action: 'quota-changed', actorId: newUuid(), actorName: 'Admin' },
      ]);

      const result = await sut.getAll(AuthFactory.create(), { userId, action: 'quota-changed' });

      expect(mocks.accountEvent.getAll).toHaveBeenCalledWith({ userId, action: 'quota-changed', take: 51 });
      expect(result).toMatchObject({ hasMore: false, events: [{ source: 'admin', actorName: 'Admin' }] });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('onNightlyDatabaseCleanup', () => {
    it('removes events older than 400 days', async () => {
      vi.useFakeTimers({ now: new Date('2026-11-09T00:00:00.000Z') });
      mocks.accountEvent.deleteOlderThan.mockResolvedValue(3);

      await sut.onNightlyDatabaseCleanup();

      expect(ACCOUNT_EVENT_RETENTION_DAYS).toBe(400);
      expect(mocks.accountEvent.deleteOlderThan).toHaveBeenCalledWith(new Date('2025-10-05T00:00:00.000Z'));
    });
  });
});

describe('account event helpers', () => {
  it.each([
    ['203.0.113.77', '203.0.113.0/24'],
    ['::ffff:192.168.1.5', '192.168.1.0/24'],
    ['2001:db8:abcd:12::1', '2001:db8:abcd::/48'],
    ['2001:db8::1', '2001:db8:0::/48'],
    ['fe80::1%en0', 'fe80:0:0::/48'],
    ['::1', '0:0:0::/48'],
    ['', null],
    ['not-an-ip', null],
  ])('cuts %s to %s', (ip, expected) => {
    expect(toIpPrefix(ip)).toBe(expected);
  });

  it('names how a request arrived', () => {
    expect(toAccountEventVia('lan')).toBe('home');
    expect(toAccountEventVia('wan')).toBe('direct');
    expect(toAccountEventVia('relay')).toBe('relay');
    expect(toAccountEventVia(null)).toBeNull();
  });
});
