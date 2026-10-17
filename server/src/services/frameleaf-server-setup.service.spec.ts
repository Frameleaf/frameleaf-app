import { FrameleafServerSetupService } from 'src/services/frameleaf-server-setup.service.js';
import { isLanRequest } from 'src/utils/frameleaf-setup.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const phone = { ip: '192.168.1.40', via: null };

describe('setup helpers (FL-292)', () => {
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
  const refusal = (code: string) => expect.objectContaining({ response: expect.objectContaining({ code }) });
  const dto = { email: 'me@example.test', password: 'a long password', name: 'Me' };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(FrameleafServerSetupService));
    mocks.config.getEnv.mockReturnValue(mockEnvData({}));
    mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
    mocks.user.getAdmin.mockResolvedValue(void 0);
  });

  it('accepts no claim when setup is disabled', async () => {
    const env = mockEnvData({});
    mocks.config.getEnv.mockReturnValue({ ...env, setup: { ...env.setup, allow: false } });
    await expect(sut.claimWithPassword(dto, phone)).rejects.toEqual(refusal('setup_complete'));
    await expect(sut.getState()).resolves.toMatchObject({ setup: 'complete' });
  });

  it('creates the password administrator from the home network, without a setup code', async () => {
    const created = UserFactory.create({ isAdmin: true, email: 'me@example.test' });
    mocks.user.getByEmail.mockResolvedValue(void 0);
    mocks.clusterGroup.create.mockResolvedValue({ id: 'group-1' } as never);
    mocks.user.create.mockResolvedValue(created as never);

    for (const client of [
      { ip: '203.0.113.9', via: null },
      { ip: phone.ip, via: 'relay' as const },
      { ip: phone.ip, via: 'wan' as const },
    ]) {
      await expect(sut.claimWithPassword(dto, client)).rejects.toEqual(refusal('setup_lan_only'));
    }
    expect(mocks.user.create).not.toHaveBeenCalled();

    await expect(sut.claimWithPassword(dto, phone)).resolves.toMatchObject({ email: 'me@example.test' });
    expect(mocks.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ isAdmin: true, email: 'me@example.test' }),
    );

    // once an administrator exists, setup is over
    mocks.user.getAdmin.mockResolvedValue(created);
    await expect(sut.claimWithPassword(dto, phone)).rejects.toEqual(refusal('setup_complete'));
  });

  it('reports the setup state an app on the network may see', async () => {
    await expect(sut.getState()).resolves.toEqual({ setup: 'needed', cloud: 'unavailable', linked: false });
    mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
    await expect(sut.getState()).resolves.toMatchObject({ setup: 'complete' });
  });
});
