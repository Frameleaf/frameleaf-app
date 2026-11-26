import { defaults } from 'src/config.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  FRAMELEAF_CLOUD_ENDPOINT,
  MachineLearningRepository,
  SCAN_SPLIT_MODEL_NAME,
  ScanSplitUnavailableError,
} from 'src/repositories/machine-learning.repository.js';

const local = 'http://frameleaf-machine-learning:3003';
const repo = (url = local) => {
  const sut = new MachineLearningRepository(LoggingRepository.create());
  sut.setup({ ...defaults.machineLearning, urls: [url] });
  return sut;
};
const print = {
  quad: [
    [10, 20],
    [410, 22],
    [408, 322],
    [8, 320],
  ],
  rotation: 0,
  confidence: 0.96,
};
afterEach(() => vi.unstubAllGlobals());

describe('scanSplitLocal (FL-923)', () => {
  it('sends the scan to one local worker as the scan-split task, with no options', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ 'scan-split': [print], imageWidth: 2048, imageHeight: 1536 }));
    vi.stubGlobal('fetch', fetch);
    await expect(repo().scanSplitLocal(Buffer.from('image'))).resolves.toEqual({
      prints: [print],
      width: 2048,
      height: 1536,
    });
    expect(String(fetch.mock.calls[0][0])).toBe(`${local}/predict`);
    const request = fetch.mock.calls[0][1];
    expect(request.redirect).toBe('error');
    // the worker validates options with a closed keyspace: anything sent here must be declared there
    expect(JSON.parse(request.body.get('entries'))).toEqual({
      'scan-split': { visual: { modelName: SCAN_SPLIT_MODEL_NAME, options: {} } },
    });
    expect(Buffer.from(await request.body.get('image').arrayBuffer()).toString()).toBe('image');
  });

  it.each([404, 422, 503])('reports a worker that cannot look for prints (%s) as unavailable', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status })));
    await expect(repo().scanSplitLocal(Buffer.alloc(1))).rejects.toBeInstanceOf(ScanSplitUnavailableError);
  });

  it('never sends a scan to Frameleaf Cloud or a frameleaf host', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(repo(FRAMELEAF_CLOUD_ENDPOINT.url).scanSplitLocal(Buffer.alloc(1))).rejects.toThrow();
    await expect(repo('https://ml.frameleaf.cloud').scanSplitLocal(Buffer.alloc(1))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a malformed answer', async () => {
    const answer = { 'scan-split': [{ ...print, rotation: 45 }], imageWidth: 2048, imageHeight: 1536 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(answer)));
    await expect(repo().scanSplitLocal(Buffer.alloc(1))).rejects.toThrow();
  });
});
