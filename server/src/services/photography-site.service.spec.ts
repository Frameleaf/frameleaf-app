import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PhotographySiteService } from 'src/services/photography-site.service.js';
import { defaultPhotographySite } from 'src/utils/photography-site.js';

const OWNER = '0195e2a0-0000-7000-8000-000000000001';
const REVISION = '0195e2a0-0000-7000-8000-0000000000aa';

const setup = (storedSlug: string) => {
  const stored = { ...defaultPhotographySite('North Studio'), slug: storedSlug };
  // what is stored; each read is a copy, as from the database
  let record: object = { site: stored, media: {} };
  const repository = {
    studioRecord: vi.fn(() => Promise.resolve({ revision: 'r1', record: structuredClone(record) })),
    siteOwnerBySlug: vi.fn().mockResolvedValue(OWNER),
    mutateStudio: vi.fn((_owner: string, _revision: string, change: (record: object) => unknown) => {
      const next = structuredClone(record);
      const result = change(next);
      record = next;
      return Promise.resolve({ revision: 'r2', record: next, result });
    }),
  };
  const workflow = { studioOwner: vi.fn().mockReturnValue(OWNER) };
  const logger = { setContext: vi.fn(), warn: vi.fn(), log: vi.fn() };
  const remoteAccess = {
    reportStudioSite: vi.fn().mockResolvedValue({ site: null, problem: null }),
    studioSiteStatus: vi.fn(),
  };
  const sut = new PhotographySiteService(
    repository as never,
    {} as never,
    workflow as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    logger as never,
    remoteAccess as never,
  );
  return { sut, repository, stored, remoteAccess };
};

describe(PhotographySiteService.name, () => {
  describe('saveSite', () => {
    it('will not move a website to the Studio project library address (FL-711)', async () => {
      const { sut, repository, stored } = setup('north-studio');

      await expect(
        sut.saveSite({} as never, { expectedRevision: REVISION, site: { ...stored, slug: 'projects' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.mutateStudio).not.toHaveBeenCalled();
    });

    it('keeps a website saved at that address before it was reserved editable where it is', async () => {
      const { sut, repository, stored } = setup('projects');

      const saved = await sut.saveSite({} as never, {
        expectedRevision: REVISION,
        site: { ...stored, about: 'Weddings and portraits' },
      });

      expect(repository.mutateStudio).toHaveBeenCalledOnce();
      expect(saved.url).toBe('/studio/projects');
    });
  });

  describe('own domain (FL-705)', () => {
    it('tells Frameleaf Cloud the domain when the website is published with one, and when it is turned off', async () => {
      const { sut, stored, remoteAccess } = setup('north-studio');

      await sut.saveSite({} as never, {
        expectedRevision: REVISION,
        site: { ...stored, enabled: true, domain: 'photos.cedarandlight.ca' },
      });
      await vi.waitFor(() =>
        expect(remoteAccess.reportStudioSite).toHaveBeenCalledWith({
          domain: 'photos.cedarandlight.ca',
          slug: 'north-studio',
        }),
      );
    });

    it('reports quick saves to Frameleaf Cloud one at a time, in save order', async () => {
      const { sut, stored, remoteAccess } = setup('north-studio');
      let release!: () => void;
      remoteAccess.reportStudioSite.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve({ site: null, problem: null }))),
      );

      for (const domain of ['old.cedarandlight.ca', 'photos.cedarandlight.ca']) {
        await sut.saveSite({} as never, { expectedRevision: REVISION, site: { ...stored, enabled: true, domain } });
      }
      await vi.waitFor(() => expect(remoteAccess.reportStudioSite).toHaveBeenCalledOnce());
      release();
      await vi.waitFor(() => expect(remoteAccess.reportStudioSite).toHaveBeenCalledTimes(2));
      // the report that waited sends what is stored now, so Cloud ends on the latest save
      expect(remoteAccess.reportStudioSite.mock.calls.at(-1)?.[0]).toEqual({
        domain: 'photos.cedarandlight.ca',
        slug: 'north-studio',
      });
    });

    it('says nothing to Frameleaf Cloud when the domain and publishing are unchanged', async () => {
      const { sut, stored, remoteAccess } = setup('north-studio');

      await sut.saveSite({} as never, { expectedRevision: REVISION, site: { ...stored, about: 'Weddings' } });
      expect(remoteAccess.reportStudioSite).not.toHaveBeenCalled();
    });

    it('tells Frameleaf Cloud again when it has never heard of the published domain', async () => {
      const { sut, repository, stored, remoteAccess } = setup('north-studio');
      repository.studioRecord.mockResolvedValue({
        revision: 'r1',
        record: { site: { ...stored, enabled: true, domain: 'photos.cedarandlight.ca' }, media: {} },
      });
      remoteAccess.studioSiteStatus.mockResolvedValue({ site: null, problem: null });
      const waiting = { domain: 'photos.cedarandlight.ca', slug: 'north-studio', status: 'waiting_for_dns' };
      remoteAccess.reportStudioSite.mockResolvedValue({ site: waiting, problem: null });

      await expect(sut.siteDomain({} as never)).resolves.toEqual({ site: waiting, problem: null });
      expect(remoteAccess.reportStudioSite).toHaveBeenCalledWith({
        domain: 'photos.cedarandlight.ca',
        slug: 'north-studio',
      });
    });
  });
});
