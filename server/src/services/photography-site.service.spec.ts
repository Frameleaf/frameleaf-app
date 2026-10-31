import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PhotographySiteService } from 'src/services/photography-site.service.js';
import { defaultPhotographySite } from 'src/utils/photography-site.js';

const OWNER = '0195e2a0-0000-7000-8000-000000000001';
const REVISION = '0195e2a0-0000-7000-8000-0000000000aa';

const setup = (storedSlug: string) => {
  const stored = { ...defaultPhotographySite('North Studio'), slug: storedSlug };
  const repository = {
    studioRecord: vi.fn().mockResolvedValue({ revision: 'r1', record: { site: stored, media: {} } }),
    siteOwnerBySlug: vi.fn().mockResolvedValue(OWNER),
    mutateStudio: vi.fn((_owner: string, _revision: string, change: (record: object) => unknown) => {
      const record = { site: stored, media: {} };
      return Promise.resolve({ revision: 'r2', record, result: change(record) });
    }),
  };
  const workflow = { studioOwner: vi.fn().mockReturnValue(OWNER) };
  const logger = { setContext: vi.fn(), warn: vi.fn(), log: vi.fn() };
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
  );
  return { sut, repository, stored };
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
});
