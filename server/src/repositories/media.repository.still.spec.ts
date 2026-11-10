import { exiftool } from 'exiftool-vendored';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import type { DecodeToBufferOptions } from 'src/types.js';
import { Colorspace } from 'src/enum.js';
import { SharpOperationError } from 'src/queue/sharp-pool.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { type StillConverter, stillConverters } from 'src/utils/still-converters.js';
import { automock } from 'test/utils.js';

vi.mock('src/utils/still-converters.js', () => ({ stillConverters: vi.fn() }));

const options = { colorspace: Colorspace.Srgb, processInvalidImages: false };
const picture = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: 'red' } }).png();

describe.each(['decodeImage', 'generateImageThumbnails'] as const)('MediaRepository still ladder: %s', (operation) => {
  let sut: MediaRepository;
  let directory: string;
  let input: string;
  const decode = (source: string | Buffer, decodeOptions: DecodeToBufferOptions = options) =>
    operation === 'decodeImage'
      ? sut.decodeImage(source, decodeOptions)
      : sut.generateImageThumbnails(source, decodeOptions, { outputs: [], edits: [], checkTransparency: false });
  const converters = (...list: Array<Pick<StillConverter, 'rung' | 'convert'>>) =>
    vi.mocked(stillConverters).mockReturnValue(list.map((converter) => ({ extension: '.png', ...converter })));
  const fails = () => Promise.reject(new Error('cannot read this'));
  const embedded = (preview?: Buffer) =>
    vi
      .spyOn(exiftool, 'extractBinaryTagToBuffer')
      .mockImplementation(() => (preview ? Promise.resolve(preview) : Promise.reject(new Error('no such tag'))));

  beforeEach(async () => {
    // eslint-disable-next-line no-sparse-arrays
    sut = new MediaRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-still-spec-'));
    input = join(directory, 'old [1] 100%d.jpg');
    await writeFile(input, 'a picture only another decoder can read');
    vi.spyOn(exiftool, 'readRaw').mockResolvedValue({ Orientation: 6 } as never);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  afterAll(() => exiftool.end());

  it('asks no other decoder about a picture libvips opens', async () => {
    await picture(16, 8).toFile(input);
    expect(await decode(input)).toMatchObject({ rung: 'strict', info: { width: 16, height: 8 } });
    expect(stillConverters).not.toHaveBeenCalled();
  });

  it('steps down to the first decoder that opens the file, and turns its copy as the original says', async () => {
    const second = vi.fn(async (_source: string, output: string) => void (await picture(16, 8).toFile(output)));
    converters({ rung: 'djpeg', convert: fails }, { rung: 'ffmpeg', convert: second });
    // orientation 6 is a quarter turn: 16x8 comes out 8x16
    expect(await decode(input)).toMatchObject({ rung: 'ffmpeg', info: { width: 8, height: 16 } });
    // the decoder is handed a plainly named link, never the awkward real name
    expect(second.mock.calls[0][0]).toMatch(/frameleaf-still-[^/\\]+[/\\]source\.jpg$/);
    // and nothing of the copies is left behind
    await expect(access(dirname(second.mock.calls[0][1]))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('shows the preview stored inside the file when nothing opens the picture', async () => {
    converters({ rung: 'ffmpeg', convert: fails });
    embedded(await picture(8, 4).toBuffer());
    expect(await decode(input)).toMatchObject({ rung: 'embedded', info: { width: 4, height: 8 } });
  });

  it('does not offer that preview to a caller that needs the picture itself', async () => {
    converters({ rung: 'ffmpeg', convert: fails });
    const preview = embedded(await picture(8, 4).toBuffer());
    await expect(decode(input, { ...options, ladder: 'pixels' })).rejects.toThrow(/^Unsupported image/);
    expect(preview).not.toHaveBeenCalled();
  });

  it('says "unsupported", as a decode failure, when every rung fails', async () => {
    converters({ rung: 'ffmpeg', convert: fails });
    embedded();
    const failure = await decode(input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SharpOperationError);
    expect(failure).toMatchObject({ decodeFailure: true, message: expect.stringMatching(/^Unsupported image/) });
  });

  it('does not call a file that is not there unsupported', async () => {
    converters({ rung: 'ffmpeg', convert: fails });
    await expect(decode(join(directory, 'gone.jpg'))).rejects.toThrow('Input file is missing');
    expect(stillConverters).not.toHaveBeenCalled();
  });

  it('stays on the strict rung when asked to', async () => {
    converters({ rung: 'ffmpeg', convert: fails });
    await expect(decode(input, { ...options, ladder: 'strict' })).rejects.toThrow('unsupported image format');
    expect(stillConverters).not.toHaveBeenCalled();
  });

  it('has no other decoder for pixels handed over in memory', async () => {
    await expect(decode(Buffer.from('damaged image'))).rejects.toThrow('unsupported image format');
    expect(stillConverters).not.toHaveBeenCalled();
  });
});
