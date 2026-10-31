import type { RawSupportFacts } from 'src/repositories/raw-support.repository.js';
import { defaults } from 'src/dtos/config.dto.js';
import { RawSupportSource, RawSupportStatus } from 'src/dtos/raw-support.dto.js';
import { Colorspace, MediaHealthStatus } from 'src/enum.js';
import { RawSupportService, rawSupportSource, rawSupportStatus } from 'src/services/raw-support.service.js';
import { getConfig } from 'src/utils/config.js';
import { factory } from 'test/small.factory.js';

vi.mock('src/utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/config.js')>()),
  getConfig: vi.fn(),
}));

const facts = (value: Partial<RawSupportFacts> = {}): RawSupportFacts => ({
  healthStatus: null,
  healthReason: null,
  hasPreview: true,
  hasFullsize: false,
  ...value,
});

const config = (image: Partial<(typeof defaults)['image']> = {}) => ({
  ...defaults,
  image: { ...defaults.image, ...image },
});

describe(RawSupportService.name, () => {
  const logger = { setContext: vi.fn(), debug: vi.fn() };
  const repository = { getSummary: vi.fn(), hasDecoder: vi.fn(), getDeveloperVersion: vi.fn() };
  const serverInfo = { getBuildVersions: vi.fn() };
  let sut: RawSupportService;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getConfig).mockResolvedValue(config());
    repository.hasDecoder.mockResolvedValue(true);
    repository.getDeveloperVersion.mockResolvedValue('darktable 5.6.2');
    serverInfo.getBuildVersions.mockResolvedValue({ libraw: 'dcraw_emu: LibRaw 0.21.3-Release' });
    repository.getSummary.mockResolvedValue({ groups: [], items: [] });
    sut = new RawSupportService(logger as never, repository as never, serverInfo as never, {} as never, {} as never);
  });

  describe('rawSupportStatus', () => {
    it('lets an open Library Care finding win over the preview', () => {
      expect(rawSupportStatus(facts({ healthStatus: MediaHealthStatus.UnsupportedRaw }), false)).toBe(
        RawSupportStatus.Unsupported,
      );
      expect(
        rawSupportStatus(
          facts({ healthStatus: MediaHealthStatus.CorruptSuspect, healthReason: 'decoder_unavailable' }),
          false,
        ),
      ).toBe(RawSupportStatus.Dependency);
      for (const reason of ['decode_timeout', 'validation_timeout', 'decoder_resource_limit']) {
        expect(
          rawSupportStatus(facts({ healthStatus: MediaHealthStatus.CorruptSuspect, healthReason: reason }), false),
        ).toBe(RawSupportStatus.Timeout);
      }
      expect(
        rawSupportStatus(
          facts({ healthStatus: MediaHealthStatus.CorruptSuspect, healthReason: 'raw_decode_damaged' }),
          false,
        ),
      ).toBe(RawSupportStatus.Damaged);
      expect(rawSupportStatus(facts({ healthStatus: MediaHealthStatus.CorruptConfirmed }), false)).toBe(
        RawSupportStatus.Damaged,
      );
    });

    it('reads the preview and its source from the files and the embedded-preview setting', () => {
      expect(rawSupportStatus(facts({ hasPreview: false }), false)).toBe(RawSupportStatus.Pending);
      expect(rawSupportSource(facts({ hasPreview: false }), true)).toBe(RawSupportSource.None);
      expect(rawSupportStatus(facts(), false)).toBe(RawSupportStatus.Ready);
      expect(rawSupportSource(facts(), false)).toBe(RawSupportSource.Sensor);
      expect(rawSupportStatus(facts(), true)).toBe(RawSupportStatus.Preview);
      expect(rawSupportSource(facts(), true)).toBe(RawSupportSource.Embedded);
      expect(rawSupportStatus(facts({ hasFullsize: true }), true)).toBe(RawSupportStatus.Ready);
      expect(rawSupportSource(facts({ hasFullsize: true }), true)).toBe(RawSupportSource.Sensor);
    });
  });

  describe('getSummary', () => {
    it("queries only the caller's files with their privacy and the requested limit", async () => {
      const auth = factory.auth();
      await sut.getSummary(auth, { limit: 50 });
      expect(repository.getSummary).toHaveBeenCalledWith(expect.objectContaining({ ownerId: auth.user.id, limit: 50 }));
    });

    it('counts every file by state and by extension, attention included', async () => {
      repository.getSummary.mockResolvedValue({
        groups: [
          { ...facts(), extension: 'cr2', count: 3 },
          { ...facts({ hasPreview: false }), extension: 'cr2', count: 1 },
          { ...facts({ healthStatus: MediaHealthStatus.UnsupportedRaw }), extension: 'raf', count: 2 },
          { ...facts(), extension: 'nef', count: 5 },
        ],
        items: [],
      });
      const result = await sut.getSummary(factory.auth(), { limit: 200 });
      expect(result.total).toBe(11);
      expect(result.counts).toEqual({
        ready: 8,
        preview: 0,
        pending: 1,
        timeout: 0,
        unsupported: 2,
        damaged: 0,
        dependency: 0,
      });
      expect(result.formats).toEqual([
        { extension: 'nef', count: 5, ready: 5, attention: 0, tested: [] },
        { extension: 'cr2', count: 4, ready: 3, attention: 0, tested: ['Canon EOS 70D'] },
        { extension: 'raf', count: 2, ready: 0, attention: 2, tested: [] },
      ]);
    });

    it('maps listed files and the server settings', async () => {
      vi.mocked(getConfig).mockResolvedValue(
        config({ extractEmbedded: true, colorspace: Colorspace.Srgb, fullsize: { ...defaults.image.fullsize } }),
      );
      const renderedAt = new Date('2026-10-16T10:00:00.000Z');
      repository.getSummary.mockResolvedValue({
        groups: [],
        items: [
          {
            ...facts(),
            assetId: 'a1',
            fileName: 'IMG_0001.CR3',
            make: 'Canon',
            model: 'EOS R5',
            width: 8192,
            height: 5464,
            renderedAt,
            pairedFileName: 'IMG_0001.JPG',
          },
        ],
      });
      const result = await sut.getSummary(factory.auth(), { limit: 200 });
      expect(result).toMatchObject({ embeddedPreviews: true, fullResolution: false, colorspace: 'srgb' });
      expect(result.items).toEqual([
        {
          assetId: 'a1',
          fileName: 'IMG_0001.CR3',
          extension: 'cr3',
          make: 'Canon',
          model: 'EOS R5',
          width: 8192,
          height: 5464,
          status: RawSupportStatus.Preview,
          source: RawSupportSource.Embedded,
          hasFullsize: false,
          renderedAt: renderedAt.toISOString(),
          pairedFileName: 'IMG_0001.JPG',
        },
      ]);
    });

    it('reports the decoder and the pinned development engine', async () => {
      const result = await sut.getSummary(factory.auth(), { limit: 200 });
      expect(result.decoder).toEqual({ available: true, version: 'LibRaw 0.21.3-Release' });
      expect(result.developer).toEqual({ available: true, version: 'darktable 5.6.2' });
    });

    it('says what is missing, and refuses another darktable release', async () => {
      repository.hasDecoder.mockResolvedValue(false);
      repository.getDeveloperVersion.mockResolvedValue('darktable 4.8.1');
      const result = await sut.getSummary(factory.auth(), { limit: 200 });
      expect(result.decoder).toEqual({ available: false, version: null });
      expect(result.developer).toEqual({ available: false, version: 'darktable 4.8.1' });
    });

    it('probes the engines once, not on every request', async () => {
      await sut.getSummary(factory.auth(), { limit: 200 });
      await sut.getSummary(factory.auth(), { limit: 200 });
      expect(repository.getDeveloperVersion).toHaveBeenCalledTimes(1);
      expect(repository.hasDecoder).toHaveBeenCalledTimes(1);
    });
  });
});
