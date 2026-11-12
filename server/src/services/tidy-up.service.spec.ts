import { BadRequestException } from '@nestjs/common';
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ClassificationCareRule } from 'src/repositories/classification.repository.js';
import {
  AlbumKind,
  ClassificationMatchDecision,
  ClassificationMediaType,
  ClassificationRuleAction,
  MediaOperationBulkAction,
} from 'src/enum.js';
import { TIDY_UP_THRESHOLDS, TidyUpService, guarded } from 'src/services/tidy-up.service.js';
import { newUuid } from 'test/small.factory.js';

const auth = { user: { id: 'owner' } } as AuthDto;

const careRule = (overrides: Partial<ClassificationCareRule> = {}) =>
  ({
    id: newUuid(),
    ownerId: 'owner',
    albumId: newUuid(),
    parentId: 'collection',
    careKind: 'memes',
    enabled: true,
    threshold: TIDY_UP_THRESHOLDS.balanced,
    action: ClassificationRuleAction.Review,
    tagId: null,
    archive: true,
    ...overrides,
  }) as ClassificationCareRule;

const outcome = { added: 0, suggested: 0, removed: 0, unchanged: 0, tagged: [], untagged: [], locked: [], missing: [] };

describe(TidyUpService.name, () => {
  let repository: Record<string, Mock<(...args: any[]) => unknown>>;
  let classification: Record<string, Mock<(...args: any[]) => unknown>>;
  let albums: { create: ReturnType<typeof vi.fn> };
  let mediaOperations: { createBulk: ReturnType<typeof vi.fn> };
  let sut: TidyUpService;

  beforeEach(() => {
    repository = {
      getCareRules: vi.fn().mockResolvedValue([]),
      countCare: vi.fn().mockResolvedValue({ waiting: new Map(), waitingTotal: 0, tidied: 0 }),
      setCareKind: vi.fn(),
      getMatches: vi.fn().mockResolvedValue([]),
      decide: vi.fn().mockResolvedValue(outcome),
      getCarePage: vi.fn(),
    };
    classification = {
      getSettings: vi.fn().mockResolvedValue({ visualSearchAvailable: true }),
      createRule: vi.fn().mockResolvedValue({ id: 'new-rule' }),
      updateRule: vi.fn(),
      plan: vi.fn().mockResolvedValue({ assetIds: ['a'], durable: false, truncated: false }),
      apply: vi.fn(),
      emitTagEvents: vi.fn(),
    };
    albums = { create: vi.fn().mockResolvedValue({ id: 'collection' }) };
    mediaOperations = { createBulk: vi.fn() };
    sut = new TidyUpService(
      { setContext: vi.fn(), warn: vi.fn() } as never,
      repository as never,
      classification as never,
      albums as never,
      mediaOperations as never,
    );
  });

  describe('guarded', () => {
    it('never suggests a favourite or a photo with stars', () => {
      expect(guarded({ hasPeople: { eq: false } })).toEqual({
        hasPeople: { eq: false },
        isFavorite: { eq: false },
        or: [{ rating: { eq: null } }, { rating: { lt: 1 } }],
      });
    });

    it('spreads the rating guard over the kind’s own alternatives', () => {
      const filter = guarded({
        or: [{ originalFileName: { like: '-WA0' } }, { originalFileName: { startsWith: 'FB_IMG_' } }],
      });
      expect(filter.or).toEqual([
        { originalFileName: { like: '-WA0' }, rating: { eq: null } },
        { originalFileName: { like: '-WA0' }, rating: { lt: 1 } },
        { originalFileName: { startsWith: 'FB_IMG_' }, rating: { eq: null } },
        { originalFileName: { startsWith: 'FB_IMG_' }, rating: { lt: 1 } },
      ]);
    });
  });

  describe('setKind', () => {
    it('turns a kind on as suggestions only, in a new Tidied away collection, and looks through the library', async () => {
      await sut.setKind(auth, 'memes', { enabled: true });

      expect(albums.create).toHaveBeenCalledWith(auth, { albumName: 'Tidied away', kind: AlbumKind.Collection });
      expect(classification.createRule).toHaveBeenCalledWith(
        auth,
        expect.objectContaining({
          albumName: 'Memes',
          parentId: 'collection',
          action: ClassificationRuleAction.Review,
          tagName: null,
          archive: true,
          archiveConsent: true,
          mediaType: ClassificationMediaType.Photo,
          threshold: TIDY_UP_THRESHOLDS.balanced,
          filter: expect.objectContaining({ isFavorite: { eq: false }, hasPeople: { eq: false } }),
        }),
      );
      expect(repository.setCareKind).toHaveBeenCalledWith('new-rule', 'memes');
      expect(classification.plan).toHaveBeenCalledWith(auth, 'new-rule');
      expect(classification.apply).toHaveBeenCalledWith(auth, 'new-rule', { assetIds: ['a'] });
    });

    it('reuses the collection a kind already sits in', async () => {
      repository.getCareRules.mockResolvedValue([careRule({ careKind: 'screenshots' })]);
      await sut.setKind(auth, 'memes', { enabled: true });
      expect(albums.create).not.toHaveBeenCalled();
      expect(classification.createRule).toHaveBeenCalledWith(auth, expect.objectContaining({ parentId: 'collection' }));
    });

    it('archives automatically only when asked, and then leaves what was already found for review', async () => {
      await sut.setKind(auth, 'memes', { enabled: true, automatic: true });
      expect(classification.createRule).toHaveBeenCalledWith(
        auth,
        expect.objectContaining({ action: ClassificationRuleAction.Tag, tagName: 'Tidied away/Memes' }),
      );
      expect(classification.plan).not.toHaveBeenCalled();
    });

    it('runs a large first look as a durable bulk job', async () => {
      classification.plan.mockResolvedValue({ assetIds: ['a', 'b'], durable: true, truncated: false });
      await sut.setKind(auth, 'screenshots', { enabled: true });
      expect(mediaOperations.createBulk).toHaveBeenCalledWith(auth, {
        action: MediaOperationBulkAction.ApplyClassificationRule,
        assetIds: ['a', 'b'],
        payload: { classificationRuleId: 'new-rule' },
        submittedTotal: 2,
        truncated: false,
      });
      expect(classification.apply).not.toHaveBeenCalled();
    });

    it('refuses a picture-based kind while Visual search is off, but not one that works from file details', async () => {
      classification.getSettings.mockResolvedValue({ visualSearchAvailable: false });
      await expect(sut.setKind(auth, 'memes', { enabled: true })).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.setKind(auth, 'screenshots', { enabled: true })).resolves.toMatchObject({ kind: 'screenshots' });
    });

    it('creates nothing when a kind that was never on is turned off', async () => {
      await sut.setKind(auth, 'memes', { enabled: false });
      expect(classification.createRule).not.toHaveBeenCalled();
    });

    it('turning a kind off only stops it: nothing is looked at again and nothing leaves the Archive', async () => {
      const rule = careRule();
      repository.getCareRules.mockResolvedValue([rule]);
      await sut.setKind(auth, 'memes', { enabled: false });
      expect(classification.updateRule).toHaveBeenCalledWith(
        auth,
        rule.id,
        expect.objectContaining({ enabled: false }),
      );
      expect(classification.plan).not.toHaveBeenCalled();
      expect(repository.decide).not.toHaveBeenCalled();
    });

    it('keeps the saved strictness and looks again when it changes', async () => {
      const rule = careRule({ threshold: TIDY_UP_THRESHOLDS.surer });
      repository.getCareRules.mockResolvedValue([rule]);
      await sut.setKind(auth, 'memes', { automatic: false });
      expect(classification.updateRule).toHaveBeenCalledWith(
        auth,
        rule.id,
        expect.objectContaining({ threshold: TIDY_UP_THRESHOLDS.surer }),
      );
      expect(classification.plan).not.toHaveBeenCalled();

      await sut.setKind(auth, 'memes', { strictness: 'more' });
      expect(classification.updateRule).toHaveBeenLastCalledWith(
        auth,
        rule.id,
        expect.objectContaining({ threshold: TIDY_UP_THRESHOLDS.more }),
      );
      expect(classification.plan).toHaveBeenCalledWith(auth, rule.id);
    });
  });

  describe('decide', () => {
    const memes = careRule({ careKind: 'memes' });
    const chat = careRule({ careKind: 'chat' });
    const match = (assetId: string, decision: ClassificationMatchDecision) => ({ assetId, decision });

    beforeEach(() => {
      repository.getCareRules.mockResolvedValue([memes, chat]);
      repository.getMatches.mockImplementation((ruleId: string) =>
        Promise.resolve(
          ruleId === memes.id
            ? [match('a', ClassificationMatchDecision.Suggested), match('b', ClassificationMatchDecision.Accepted)]
            : [match('a', ClassificationMatchDecision.Suggested), match('c', ClassificationMatchDecision.Matched)],
        ),
      );
    });

    it('archives suggestions for every kind that found them', async () => {
      await expect(sut.decide(auth, { assetIds: ['a', 'b', 'c'], decision: 'archive' })).resolves.toEqual({
        updated: 1,
        skipped: 2,
      });
      expect(repository.decide).toHaveBeenCalledWith(memes, ['a'], ClassificationMatchDecision.Accepted);
      expect(repository.decide).toHaveBeenCalledWith(chat, ['a'], ClassificationMatchDecision.Accepted);
    });

    it('keep turns a photo down for every kind, archived or not, so no kind suggests it again', async () => {
      await sut.decide(auth, { assetIds: ['a', 'b', 'c'], decision: 'keep' });
      expect(repository.decide).toHaveBeenCalledWith(memes, ['a', 'b'], ClassificationMatchDecision.Rejected);
      expect(repository.decide).toHaveBeenCalledWith(chat, ['a', 'c'], ClassificationMatchDecision.Rejected);
      expect(classification.emitTagEvents).toHaveBeenCalledTimes(2);
    });

    it('undo puts only what the person archived back up for review', async () => {
      await sut.decide(auth, { assetIds: ['a', 'b', 'c'], decision: 'undo' });
      expect(repository.decide).toHaveBeenCalledTimes(1);
      expect(repository.decide).toHaveBeenCalledWith(memes, ['b'], ClassificationMatchDecision.Suggested);
    });
  });
});
