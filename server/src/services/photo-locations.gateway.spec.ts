import { PhotoLocationsService } from 'src/services/photo-locations.service.js';
import { loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';

vi.mock('src/utils/frameleaf-cloud-gateway.js', () => ({ loadInstanceIdentity: vi.fn(), readCloudLink: vi.fn() }));

const binding = {
  cloudUrl: 'https://cloud.invalid',
  linked: true,
  link: { instanceId: 'instance', linkedAt: 'original', status: 'linked' },
};
const setup = () => {
  vi.mocked(readCloudLink).mockResolvedValue(binding as never);
  vi.mocked(loadInstanceIdentity).mockResolvedValue({} as never);
  const cloud = {
    discovery: vi.fn().mockResolvedValue({ api: 'https://api.cloud.invalid' }),
    accessToken: vi.fn().mockResolvedValue({ accessToken: 'fresh', signer: {} }),
    requestJson: vi.fn().mockResolvedValue({ ok: true }),
  };
  const service = new PhotoLocationsService(
    {} as never,
    cloud as never,
    {} as never,
    {} as never,
    {} as never,
    { currentSigner: vi.fn() } as never,
    {} as never,
    { setContext: vi.fn() } as never,
  );
  return {
    cloud,
    gateway: (owner: string) =>
      (
        service as unknown as {
          gateway: (owner: string) => Promise<{ request: (schema: unknown, path: string) => Promise<unknown> }>;
        }
      ).gateway(owner),
  };
};

afterEach(() => vi.resetAllMocks());

it('obtains a current bound token at each request, including after long preparation', async () => {
  const { cloud, gateway } = setup();
  const client = await gateway('owner');
  expect(cloud.accessToken).not.toHaveBeenCalled();
  await client.request({}, '/v1/locations/status');
  await client.request({}, '/v1/locations/status');
  expect(cloud.accessToken).toHaveBeenCalledTimes(2);
});

it('refuses a relink between preparation and upload before sending coordinates', async () => {
  const { cloud, gateway } = setup();
  const client = await gateway('owner');
  vi.mocked(readCloudLink).mockResolvedValue({ ...binding, link: { ...binding.link, linkedAt: 'different' } } as never);
  await expect(client.request({}, '/v1/locations/scans')).rejects.toThrow('link changed');
  expect(cloud.requestJson).not.toHaveBeenCalled();
});
