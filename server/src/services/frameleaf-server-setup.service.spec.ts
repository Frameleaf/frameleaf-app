import { createHash } from 'node:crypto';
import { SystemMetadataKey } from 'src/enum.js';
import { FrameleafServerSetupService } from 'src/services/frameleaf-server-setup.service.js';
import {
  SETUP_CODE_ALPHABET,
  generateSetupCode,
  isLanRequest,
  normalizeSetupCode,
  setupCodeMatches,
} from 'src/utils/frameleaf-setup.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const phone = { ip: '192.168.1.40', via: null };
type State = { code: string; failures: number; locked: boolean; pinned: boolean; ticket?: { address: string } };

describe('setup code helpers (FL-292)', () => {
  it('makes 8-character codes from an unambiguous alphabet', () => {
    expect(SETUP_CODE_ALPHABET).not.toMatch(/[01ILO]/);
    for (let index = 0; index < 50; index += 1) {
      expect(generateSetupCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it('accepts the code however it is typed, and nothing else', () => {
    expect(normalizeSetupCode(' abcd-2345 ')).toBe('ABCD2345');
    expect(setupCodeMatches('abcd-2345', 'ABCD2345')).toBe(true);
    expect(setupCodeMatches('ABCD2346', 'ABCD2345')).toBe(false);
    expect(setupCodeMatches('ABCD', 'ABCD2345')).toBe(false);
    expect(setupCodeMatches('', 'ABCD2345')).toBe(false);
  });

  it('counts only the home network as local', () => {
    expect(isLanRequest(null, '192.168.1.4', [])).toBe(true);
    expect(isLanRequest(null, '::ffff:10.0.0.4', [])).toBe(true);
    expect(isLanRequest('lan', '203.0.113.9', [])).toBe(true);
    expect(isLanRequest(null, '203.0.113.9', [])).toBe(false);
    expect(isLanRequest(null, '100.64.1.2', ['100.64.0.0/10'])).toBe(true);
    expect(isLanRequest('relay', '192.168.1.4', [])).toBe(false);
    expect(isLanRequest('wan', '192.168.1.4', [])).toBe(false);
  });
});

describe(FrameleafServerSetupService.name, () => {
  let sut: FrameleafServerSetupService;
  let mocks: ServiceMocks;
  let metadata: Map<string, unknown>;
  let pinned: string | null;
  const state = () => metadata.get(SystemMetadataKey.FrameleafSetupCode) as State | undefined;
  const refusal = (code: string, extra: object = {}) =>
    expect.objectContaining({ response: expect.objectContaining({ code, ...extra }) });
  const printed = () => stdout.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
  let stdout: { mock: { calls: unknown[][] }; mockClear: () => void; mockRestore: () => void };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(FrameleafServerSetupService));
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true) as never;
    onTestFinished(() => stdout.mockRestore());
    metadata = new Map();
    pinned = null;
    const env = mockEnvData({});
    mocks.config.getEnv.mockImplementation(
      () => ({ ...env, frameleafCloud: { ...env.frameleafCloud, setupCode: pinned } }) as never,
    );
    mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, value);
      return Promise.resolve();
    });
    mocks.systemMetadata.delete.mockImplementation((key) => {
      metadata.delete(key);
      return Promise.resolve();
    });
    mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
    mocks.user.getAdmin.mockResolvedValue(void 0);
    mocks.crypto.randomBytesAsText.mockReturnValue('a-random-setup-ticket-0123456789');
    mocks.crypto.hashSha256.mockImplementation((value: string | Buffer) => createHash('sha256').update(value).digest());
  });

  it('does not announce a code or accept a claim when setup is disabled', async () => {
    const env = mockEnvData({});
    mocks.config.getEnv.mockReturnValue({ ...env, setup: { ...env.setup, allow: false } });
    await sut.onBootstrap();
    expect(state()).toBeUndefined();
    expect(printed()).toBe('');
    await expect(sut.issueTicket({ code: 'ABCD2345' }, phone)).rejects.toEqual(refusal('setup_complete'));
    await expect(sut.getState()).resolves.toMatchObject({ setup: 'complete' });
  });

  it('shows a new code with its QR code on the console at every start, while there is no administrator', async () => {
    await sut.onBootstrap();
    const first = state()!.code;
    expect(first).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(printed()).toContain(`${first.slice(0, 4)}-${first.slice(4)}`);
    expect(printed()).toMatch(/[█▀▄]/);
    // the log line itself never carries the code
    expect(mocks.logger.log.mock.calls.map(([line]) => line).join('\n')).not.toContain(first.slice(0, 4));

    await sut.onBootstrap();
    expect(state()!.code).not.toBe(first);

    // set up: nothing is kept, nothing is shown
    mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
    stdout.mockClear();
    await sut.onBootstrap();
    expect(state()).toBeUndefined();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('hands out a ticket for the right code, from the home network only, and never the code', async () => {
    await sut.onBootstrap();
    const code = state()!.code;
    const response = await sut.issueTicket({ code: code.toLowerCase() }, phone);
    expect(response).toEqual({ ticket: 'a-random-setup-ticket-0123456789', expiresAt: expect.any(String) });
    expect(JSON.stringify(response)).not.toContain(code);
    expect(state()!.ticket).toMatchObject({ address: phone.ip });

    await expect(sut.issueTicket({ code }, { ip: '203.0.113.9', via: null })).rejects.toEqual(
      refusal('setup_lan_only'),
    );
    await expect(sut.issueTicket({ code }, { ip: phone.ip, via: 'relay' })).rejects.toEqual(refusal('setup_lan_only'));
    mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
    await expect(sut.issueTicket({ code }, phone)).rejects.toEqual(refusal('setup_complete'));
  });

  it('counts wrong codes, says how many tries are left, and replaces the code after the fifth', async () => {
    await sut.onBootstrap();
    const code = state()!.code;
    for (let left = 4; left >= 1; left -= 1) {
      await expect(sut.issueTicket({ code: 'WRONGONE' }, phone)).rejects.toEqual(
        refusal('setup_code_invalid', { attemptsLeft: left }),
      );
    }
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining(phone.ip));
    await expect(sut.issueTicket({ code: 'WRONGONE' }, phone)).rejects.toEqual(refusal('setup_code_replaced'));
    expect(state()!.code).not.toBe(code);
    // the old code is no use any more
    await expect(sut.issueTicket({ code }, phone)).rejects.toEqual(refusal('setup_code_invalid', { attemptsLeft: 4 }));
    await expect(sut.issueTicket({ code: '' }, phone)).rejects.toEqual(refusal('setup_code_required'));
  });

  it('locks a pinned code after five wrong tries until the next start', async () => {
    pinned = 'ABCD2345';
    await sut.onBootstrap();
    for (let index = 0; index < 4; index += 1) {
      await expect(sut.issueTicket({ code: 'WRONGONE' }, phone)).rejects.toEqual(refusal('setup_code_invalid'));
    }
    await expect(sut.issueTicket({ code: 'WRONGONE' }, phone)).rejects.toEqual(refusal('setup_code_locked'));
    await expect(sut.issueTicket({ code: 'ABCD-2345' }, phone)).rejects.toEqual(refusal('setup_code_locked'));
    await sut.onBootstrap();
    await expect(sut.issueTicket({ code: 'ABCD-2345' }, phone)).resolves.toMatchObject({ ticket: expect.any(String) });
  });

  it('creates the password administrator with a ticket from the same device, once', async () => {
    await sut.onBootstrap();
    const { ticket } = await sut.issueTicket({ code: state()!.code }, phone);
    const created = UserFactory.create({ isAdmin: true, email: 'me@example.test' });
    mocks.user.getByEmail.mockResolvedValue(void 0);
    mocks.clusterGroup.create.mockResolvedValue({ id: 'group-1' } as never);
    mocks.user.create.mockResolvedValue(created as never);
    const dto = { ticket, email: 'me@example.test', password: 'a long password', name: 'Me' };

    await expect(sut.claimWithPassword(dto, { ...phone, ip: '192.168.1.41' })).rejects.toEqual(
      refusal('setup_ticket_invalid'),
    );
    // the app's routes take only the ticket: none, or the code in its place, is refused
    for (const notATicket of ['', state()!.code]) {
      await expect(sut.claimWithPassword({ ...dto, ticket: notATicket }, phone)).rejects.toEqual(
        refusal('setup_ticket_invalid'),
      );
    }
    expect(mocks.user.create).not.toHaveBeenCalled();
    // a refused claim (an email already taken) leaves the ticket for another try
    mocks.user.getByEmail.mockResolvedValueOnce(UserFactory.create() as never);
    await expect(sut.claimWithPassword(dto, phone)).rejects.toThrow('Email is not available');
    await expect(sut.claimWithPassword(dto, phone)).resolves.toMatchObject({ email: 'me@example.test' });
    expect(mocks.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ isAdmin: true, email: 'me@example.test' }),
    );
    await expect(sut.claimWithPassword(dto, phone)).rejects.toEqual(refusal('setup_ticket_invalid'));

    // the first administrator ends setup
    await sut.onUserCreate({ isAdmin: true } as never);
    expect(state()).toBeUndefined();
  });

  it('reports the setup state an app on the network may see', async () => {
    await expect(sut.getState()).resolves.toEqual({ setup: 'needed', cloud: 'unavailable', linked: false });
    mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
    await expect(sut.getState()).resolves.toMatchObject({ setup: 'complete' });
  });
});
