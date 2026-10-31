import { getAssetStatistics, getMyUser, getServerVersion, getSupportedMediaTypes } from '@frameleaf/sdk';
import { serverInfo } from 'src/commands/server-info';
import { authenticate, requirePermissions } from 'src/utils';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  getAssetStatistics: vi.fn(),
  getMyUser: vi.fn(),
  getServerVersion: vi.fn(),
  getSupportedMediaTypes: vi.fn(),
}));
vi.mock('src/utils', () => ({ authenticate: vi.fn(), requirePermissions: vi.fn() }));

beforeEach(() => {
  vi.mocked(authenticate).mockResolvedValue({ url: 'https://example.com', key: 'fixture' });
  vi.mocked(requirePermissions).mockResolvedValue(undefined);
  vi.mocked(getAssetStatistics).mockResolvedValue({ images: 3, videos: 2, total: 5 } as never);
  vi.mocked(getMyUser).mockResolvedValue({ email: 'reader@example.com' } as never);
  vi.mocked(getServerVersion).mockResolvedValue({ major: 3, minor: 2, patch: 1 } as never);
  vi.mocked(getSupportedMediaTypes).mockResolvedValue({ image: ['.jpg', '.png'], video: ['.mp4'], sidecar: [] });
});
afterEach(() => vi.restoreAllMocks());

it('writes the unchanged server report in one output call', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await serverInfo({ configDirectory: '/synthetic' });
  expect(output).toHaveBeenCalledExactlyOnceWith(
    [
      'Server Info (via reader@example.com)',
      '  Url: https://example.com',
      '  Version: 3.2.1',
      '  Formats:',
      '    Images: jpg,png',
      '    Videos: mp4',
      '  Statistics:',
      '    Images: 3',
      '    Videos: 2',
      '    Total: 5',
    ].join('\n'),
  );
});

it('propagates a request failure without printing a partial report', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const failure = new Error('statistics unavailable');
  vi.mocked(getAssetStatistics).mockRejectedValueOnce(failure);
  await expect(serverInfo({ configDirectory: '/synthetic' })).rejects.toBe(failure);
  expect(output).not.toHaveBeenCalled();
});
