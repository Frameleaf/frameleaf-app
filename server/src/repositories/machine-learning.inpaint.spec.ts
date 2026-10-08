import { defaults } from 'src/config.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  FRAMELEAF_CLOUD_ENDPOINT,
  INPAINT_MODEL_NAME,
  InpaintUnavailableError,
  MachineLearningRepository,
} from 'src/repositories/machine-learning.repository.js';

const local = 'http://immich-machine-learning:3003';
const repo = (url = local) => {
  const sut = new MachineLearningRepository(LoggingRepository.create());
  sut.setup({ ...defaults.machineLearning, urls: [url] });
  return sut;
};
afterEach(() => vi.unstubAllGlobals());

describe('inpaintLocal (Clean Up Remove fills)', () => {
  it('sends the image and its mask to one local worker as the inpaint task', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ inpaint: { png: Buffer.from('png').toString('base64'), width: 4, height: 3 } }),
      );
    vi.stubGlobal('fetch', fetch);
    expect(await repo().inpaintLocal(Buffer.from('image'), Buffer.from('mask'))).toEqual(Buffer.from('png'));
    expect(String(fetch.mock.calls[0][0])).toBe(`${local}/predict`);
    const request = fetch.mock.calls[0][1];
    expect(request.redirect).toBe('error');
    expect(JSON.parse(request.body.get('entries'))).toEqual({
      inpaint: { visual: { modelName: INPAINT_MODEL_NAME, options: {} } },
    });
    expect(Buffer.from(await request.body.get('mask').arrayBuffer()).toString()).toBe('mask');
  });

  it.each([404, 422, 503])('reports a worker without an inpainting model (%s) as unavailable', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status })));
    await expect(repo().inpaintLocal(Buffer.alloc(1), Buffer.alloc(1))).rejects.toBeInstanceOf(InpaintUnavailableError);
  });

  it('never sends media to Frameleaf Cloud or a frameleaf host', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(repo(FRAMELEAF_CLOUD_ENDPOINT.url).inpaintLocal(Buffer.alloc(1), Buffer.alloc(1))).rejects.toThrow();
    await expect(repo('https://ml.frameleaf.cloud').inpaintLocal(Buffer.alloc(1), Buffer.alloc(1))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a malformed answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ inpaint: { png: '!!', width: 0, height: 1 } })));
    await expect(repo().inpaintLocal(Buffer.alloc(1), Buffer.alloc(1))).rejects.toThrow();
  });
});
