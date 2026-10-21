import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HardwareCheck } from 'src/dtos/hardware-check.dto.js';
import type { HelpIndex } from 'src/dtos/help.dto.js';
import { serverVersion } from 'src/constants.js';
import { SystemMetadataKey } from 'src/enum.js';
import { HelpService, askHardware } from 'src/services/help.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const snapshot = JSON.parse(
  readFileSync(new URL('../../resources/help/help-index.json', import.meta.url), 'utf8'),
) as HelpIndex;
const article = (id: string) => ({
  id,
  url: `/docs/${id}/`,
  section: id.split('/', 1)[0],
  sectionTitle: 'Using Frameleaf',
  title: id,
  description: '',
  appScreens: [],
  intro: '',
  headings: [],
  text: '',
});
const fresh: HelpIndex = {
  format: 1,
  source: 'https://frameleaf.app',
  builtAt: '2026-10-22T00:00:00.000Z',
  screens: ['albums'],
  articles: [article('using/sharing')],
};

const container = (patch: Partial<HardwareCheck['ml']>): HardwareCheck['ml'] => ({
  reachable: true,
  vendor: null,
  model: null,
  vramGb: null,
  driver: null,
  backend: 'CPU',
  test: null,
  gpu: { present: null, visible: null, usable: null },
  ...patch,
});
const rtx = {
  ml: container({ vendor: 'NVIDIA', model: 'GeForce RTX 3060', vramGb: 12, backend: 'CUDA' }),
  server: container({ backend: 'NVENC' }),
} as HardwareCheck;

const json = (body: unknown, init: ResponseInit = {}) =>
  Response.json(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const answer = {
  kind: 'answer',
  blocks: [{ text: 'Open the album and choose Share.', sourceIds: ['s'] }],
  sources: [{ id: 's', title: 'Sharing', url: '/docs/using/sharing/' }],
  questions: [],
};

describe(HelpService.name, () => {
  let sut: HelpService;
  let mocks: ServiceMocks;
  let metadata: Partial<Record<SystemMetadataKey, unknown>>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearConfigCache();
    ({ sut, mocks } = newTestService(HelpService));
    metadata = {};
    mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata[key] ?? null) as never));
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('getIndex', () => {
    it('serves the copy in the image until the website has been reached, and refreshes in the background', async () => {
      fetchSpy.mockResolvedValue(json(fresh, { headers: { etag: '"v2"' } }));

      const first = await sut.getIndex();
      expect(first.updatedAt).toBeNull();
      expect(first.articles).toHaveLength(snapshot.articles.length);
      expect(fetchSpy).toHaveBeenCalledWith('https://frameleaf.app/help-index.json', expect.anything());

      await vi.waitFor(() => expect(mocks.systemMetadata.set).toHaveBeenCalled());
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.HelpIndex, {
        index: fresh,
        etag: '"v2"',
        fetchedAt: expect.any(String),
      });
      const second = await sut.getIndex();
      expect(second.articles.map((item) => item.id)).toEqual(['using/sharing']);
      expect(second.offline).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps the last good copy and says it is offline when the website cannot be reached', async () => {
      metadata[SystemMetadataKey.HelpIndex] = { index: fresh, etag: '"v2"', fetchedAt: '2026-01-01T00:00:00.000Z' };
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      await sut.getIndex();
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ headers: { 'if-none-match': '"v2"' } });
      await vi.waitFor(async () => expect((await sut.getIndex()).offline).toBe(true));
      const index = await sut.getIndex();
      expect(index.articles.map((item) => item.id)).toEqual(['using/sharing']);
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      // a failure waits before trying again
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('refuses an index that does not look like one', async () => {
      fetchSpy.mockResolvedValue(json({ format: 2, articles: [] }));
      await sut.getIndex();
      await vi.waitFor(async () => expect((await sut.getIndex()).offline).toBe(true));
      expect((await sut.getIndex()).articles).toHaveLength(snapshot.articles.length);
    });

    it('does not call out while the copy is less than a day old', async () => {
      metadata[SystemMetadataKey.HelpIndex] = { index: fresh, etag: null, fetchedAt: new Date().toISOString() };
      const index = await sut.getIndex();
      expect(index.updatedAt).not.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("reports whether Ask is on and the hardware it's told about", async () => {
      metadata[SystemMetadataKey.HelpIndex] = { index: fresh, etag: null, fetchedAt: new Date().toISOString() };
      metadata[SystemMetadataKey.HardwareCheck] = rtx;
      metadata[SystemMetadataKey.SystemConfig] = { help: { askEnabled: false } };
      expect((await sut.getIndex()).ask).toEqual({
        enabled: false,
        hardware: `NVIDIA GeForce RTX 3060 · 12 GB · CUDA · Frameleaf ${serverVersion}`,
      });
    });
  });

  describe('getArticle', () => {
    beforeEach(() => {
      metadata[SystemMetadataKey.HelpIndex] = { index: fresh, etag: null, fetchedAt: new Date().toISOString() };
    });

    it('fetches an article in the index once and keeps it', async () => {
      fetchSpy.mockResolvedValue(new Response('# Sharing\n\nShare with family.'));
      expect(await sut.getArticle('using/sharing')).toEqual({
        id: 'using/sharing',
        url: '/docs/using/sharing/',
        markdown: '# Sharing\n\nShare with family.',
      });
      await sut.getArticle('using/sharing');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith('https://frameleaf.app/content/docs/using/sharing.md', expect.anything());
    });

    it('never fetches a page that is not a help article', async () => {
      await expect(sut.getArticle('admin/secret')).rejects.toBeInstanceOf(NotFoundException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('says so when the website cannot be reached', async () => {
      fetchSpy.mockResolvedValue(new Response('', { status: 502 }));
      await expect(sut.getArticle('using/sharing')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('ask', () => {
    it("relays the question with this server's hardware and the screen", async () => {
      metadata[SystemMetadataKey.HardwareCheck] = rtx;
      fetchSpy.mockResolvedValue(json(answer));

      const result = await sut.ask(
        authStub.user1,
        { question: 'How do I share?', turns: [], screen: 'albums' },
        new AbortController().signal,
      );

      expect(result).toEqual(answer);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://frameleaf.app/api/ask/app');
      expect(JSON.parse(init.body)).toEqual({
        question: 'How do I share?',
        turns: [],
        hardware: { gpu: 'NVIDIA GeForce RTX 3060', vramGiB: 12, runtime: 'cuda', version: serverVersion.toString() },
        context: { screen: 'albums' },
      });
      expect(init.headers['x-ask-session']).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      expect(init.headers['x-ask-session']).not.toContain(authStub.user1.user.id);
    });

    it('is refused when an administrator turned Ask off', async () => {
      metadata[SystemMetadataKey.SystemConfig] = { help: { askEnabled: false } };
      await expect(
        sut.ask(authStub.user1, { question: 'Hi', turns: [] }, new AbortController().signal),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('never passes on an answer in an unexpected shape', async () => {
      fetchSpy.mockResolvedValue(json({ kind: 'answer', blocks: [{ text: '<script>', sourceIds: [], extra: 1 }] }));
      await expect(
        sut.ask(authStub.user1, { question: 'Hi', turns: [] }, new AbortController().signal),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('passes on that the Ask service is busy', async () => {
      fetchSpy.mockResolvedValue(json({ error: 'busy' }, { status: 429 }));
      await expect(
        sut.ask(authStub.user1, { question: 'Hi', turns: [] }, new AbortController().signal),
      ).rejects.toMatchObject({ status: 429 });
    });
  });

  describe(askHardware.name, () => {
    it('falls back to the server container and leaves out what is unknown', () => {
      const check = {
        ml: container({}),
        server: container({ vendor: 'Intel', model: 'Arc A380', backend: 'QSV' }),
      } as HardwareCheck;
      expect(askHardware(check)).toEqual({
        hardware: { gpu: 'Intel Arc A380', runtime: 'cpu', version: serverVersion.toString() },
        label: `Intel Arc A380 · CPU · Frameleaf ${serverVersion}`,
      });
      expect(askHardware(null)).toEqual({
        hardware: { version: serverVersion.toString() },
        label: `Frameleaf ${serverVersion}`,
      });
    });
  });
});
