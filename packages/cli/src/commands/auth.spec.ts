import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { writeAuthFile } from 'src/utils';
import { login } from './auth';

vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), unlink: vi.fn() }));
vi.mock('@frameleaf/sdk', () => ({ getMyUser: vi.fn(), Permission: { UserRead: 'user.read' } }));
vi.mock('src/utils', () => ({
  connect: vi.fn(),
  requirePermissions: vi.fn(),
  withError: vi.fn(() => Promise.resolve([undefined, { email: 'fixture@example.test' }])),
  writeAuthFile: vi.fn(),
  getAuthFilePath: vi.fn(() => '/synthetic-config/auth.yml'),
  logError: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

it('writes auth when recursive mkdir reports that another caller created the directory', async () => {
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(mkdir).mockResolvedValue(undefined);
  await login('https://fixture.example.test', 'fixture-key', { configDirectory: '/synthetic-config' });
  expect(writeAuthFile).toHaveBeenCalledWith('/synthetic-config', {
    url: 'https://fixture.example.test',
    key: 'fixture-key',
  });
});

it('does not write auth when directory creation fails', async () => {
  const failure = new Error('directory denied');
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(mkdir).mockRejectedValue(failure);
  await expect(
    login('https://fixture.example.test', 'fixture-key', { configDirectory: '/synthetic-config' }),
  ).rejects.toBe(failure);
  expect(writeAuthFile).not.toHaveBeenCalled();
});
