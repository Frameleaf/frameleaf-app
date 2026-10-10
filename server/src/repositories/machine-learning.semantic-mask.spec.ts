import { defaults } from 'src/config.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FRAMELEAF_CLOUD_ENDPOINT, MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';

const local = 'http://immich-machine-learning:3003';
const repo = (url = local) => {
  const sut = new MachineLearningRepository(LoggingRepository.create());
  sut.setup({ ...defaults.machineLearning, urls: [url] });
  return sut;
};
afterEach(() => vi.unstubAllGlobals());
it('sends pinned semantic task to one local worker and refuses Cloud or redirects', async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      'semantic-mask': {
        png: Buffer.from('png').toString('base64'),
        width: 10,
        height: 20,
        coordinates: 'sensor-active',
      },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  expect(await repo().semanticMaskLocal(Buffer.from('private-canvas'), 'sky')).toEqual(Buffer.from('png'));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0][0])).toBe(`${local}/predict`);
  const request = fetch.mock.calls[0][1];
  expect(request.redirect).toBe('error');
  expect(JSON.parse(request.body.get('entries'))).toEqual({
    'semantic-mask': { visual: { modelName: 'frameleaf-florence2-sam2.1', options: { target: 'sky' } } },
  });
  fetch.mockClear();
  await expect(repo(FRAMELEAF_CLOUD_ENDPOINT.url).semanticMaskLocal(Buffer.alloc(1), 'subject')).rejects.toThrow();
  await expect(repo('https://api.frameleaf.app').semanticMaskLocal(Buffer.alloc(1), 'subject')).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('does not reroute failures and rejects output coordinates or oversized streamed results', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  await expect(repo().semanticMaskLocal(Buffer.alloc(1), 'subject')).rejects.toThrow('503');
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValue(
    Response.json({ 'semantic-mask': { png: 'YWJj', width: 1, height: 1, coordinates: 'display' } }),
  );
  await expect(repo().semanticMaskLocal(Buffer.alloc(1), 'subject')).rejects.toThrow();
  fetch.mockResolvedValue(new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
  await expect(repo().semanticMaskLocal(Buffer.alloc(1), 'subject')).rejects.toThrow('too large');
});
