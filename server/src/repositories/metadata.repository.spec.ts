import { ExifTool, Tags } from 'exiftool-vendored';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { automock } from 'test/utils.js';

describe('metadata reads', () => {
  let sut: MetadataRepository;
  beforeEach(() => {
    sut = new MetadataRepository(
      automock(LoggingRepository, { args: [undefined, { getEnv: () => ({}) }], strict: false }),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await sut.teardown();
  });

  it('propagates a rejected read', async () => {
    const failure = new Error('unreadable');
    vi.spyOn(ExifTool.prototype, 'read').mockRejectedValue(failure);
    await expect(sut.readTags('original.jpg')).rejects.toBe(failure);
  });
  it.each([{ errors: ['corrupt metadata'] }, { Error: 'truncated file' }])(
    'rejects resolved ExifTool errors: %j',
    async (result) => {
      vi.spyOn(ExifTool.prototype, 'read').mockResolvedValue(result as Tags);
      await expect(sut.readTags('original.jpg')).rejects.toThrow(/corrupt metadata|truncated file/);
    },
  );
  it('permits a successful metadata-free image', async () => {
    vi.spyOn(ExifTool.prototype, 'read').mockResolvedValue({ FileType: 'JPEG', errors: [] } as Tags);
    await expect(sut.readTags('original.jpg')).resolves.toMatchObject({ FileType: 'JPEG' });
  });
  it.each(['Camera A or Camera B, editor', 'digest', 'Unknown (digest)'])(
    'retains raw digest and explanatory lookup %s',
    async (lookup) => {
      const read = vi
        .spyOn(ExifTool.prototype, 'readRaw')
        .mockResolvedValueOnce({ JPEGDigest: 'digest' } as unknown as Tags)
        .mockResolvedValueOnce({ JPEGDigest: lookup } as unknown as Tags);
      await expect(sut.readJpegSignature('original.jpg')).resolves.toEqual({
        method: 'jpeg-signature',
        signature: 'digest',
        matches: lookup === 'Camera A or Camera B, editor' ? lookup : null,
      });
      expect(read).toHaveBeenNthCalledWith(1, 'original.jpg', { readArgs: ['-JPEGDigest', '-n'] });
      expect(read).toHaveBeenNthCalledWith(2, 'original.jpg', { readArgs: ['-JPEGDigest'] });
    },
  );
  it('rejects optional read errors and returns null for a missing digest', async () => {
    const read = vi
      .spyOn(ExifTool.prototype, 'readRaw')
      .mockResolvedValueOnce({ errors: ['digest failed'] } as Tags)
      .mockResolvedValueOnce({} as Tags);
    await expect(sut.readJpegSignature('original.jpg')).rejects.toThrow('digest failed');
    read.mockResolvedValue({} as Tags);
    await expect(sut.readJpegSignature('original.jpg')).resolves.toBeNull();
  });
});
