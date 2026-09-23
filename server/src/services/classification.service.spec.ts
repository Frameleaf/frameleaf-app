import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ClassificationRuleWithAlbum } from 'src/repositories/classification.repository.js';
import {
  ClassificationMatchDecision,
  ClassificationMediaType,
  ClassificationRuleAction,
  MediaOperationItemStatus,
} from 'src/enum.js';
import { ClassificationService } from 'src/services/classification.service.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const criteria = {
  personIds: [],
  tagIds: [] as string[],
  takenAfter: null,
  takenBefore: null,
  mediaType: ClassificationMediaType.Any,
  visualQueries: [] as string[],
  threshold: 0.25,
};

const ruleOf = (overrides: Partial<ClassificationRuleWithAlbum> = {}): ClassificationRuleWithAlbum => ({
  id: newUuid(),
  ownerId: newUuid(),
  albumId: newUuid(),
  albumName: 'Lake days',
  tagName: null,
  enabled: true,
  ...criteria,
  tagIds: [newUuid()],
  action: ClassificationRuleAction.Review,
  tagId: null,
  archive: false,
  archiveConsentAt: null,
  createdAt: new Date().toISOString() as never,
  updatedAt: new Date().toISOString() as never,
  lastAppliedAt: null,
  ...overrides,
});

const emptyOutcome = { added: 0, suggested: 0, removed: 0, unchanged: 0, tagged: [], untagged: [] };

describe(ClassificationService.name, () => {
  let sut: ClassificationService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ClassificationService));
    mocks.classification.getCounts.mockResolvedValue(new Map());
    mocks.classification.apply.mockResolvedValue({ ...emptyOutcome });
    mocks.classification.findMatches.mockResolvedValue([]);
    mocks.classification.markApplied.mockResolvedValue(new Date());
  });

  describe('createRule', () => {
    it('refuses a rule with nothing to match, so it can never sweep the whole library', async () => {
      const auth = factory.auth();
      await expect(
        sut.createRule(auth, { ...criteria, albumName: 'All', archive: false, enabled: true }),
      ).rejects.toThrow('Add at least one rule');
      expect(mocks.album.create).not.toHaveBeenCalled();
    });

    it('refuses to archive without explicit consent and creates nothing', async () => {
      const auth = factory.auth();
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-1']));
      await expect(
        sut.createRule(auth, { ...criteria, tagIds: ['tag-1'], albumName: 'Receipts', archive: true, enabled: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.album.create).not.toHaveBeenCalled();
      expect(mocks.classification.createRule).not.toHaveBeenCalled();
    });

    it('refuses visual phrases when visual categories are turned off', async () => {
      const auth = factory.auth();
      mocks.systemMetadata.get.mockResolvedValue({ smartAlbums: { rules: { visualCategories: false } } });
      await expect(
        sut.createRule(auth, {
          ...criteria,
          visualQueries: ['lake'],
          albumName: 'Lake',
          archive: false,
          enabled: true,
        }),
      ).rejects.toThrow('turned off');
    });
  });

  describe('updateRule', () => {
    it('needs consent to turn archiving on, and clears it when archiving is turned off', async () => {
      const auth = factory.auth();
      const rule = ruleOf({ ownerId: auth.user.id });
      mocks.classification.getRule.mockResolvedValue(rule);

      await expect(sut.updateRule(auth, rule.id, { archive: true })).rejects.toThrow('explicit consent');
      expect(mocks.classification.updateRule).not.toHaveBeenCalled();

      await sut.updateRule(auth, rule.id, { archive: true, archiveConsent: true });
      expect(mocks.classification.updateRule).toHaveBeenLastCalledWith(
        rule.id,
        expect.objectContaining({ archive: true, archiveConsentAt: expect.any(String) }),
      );

      mocks.classification.getRule.mockResolvedValue({
        ...rule,
        archive: true,
        archiveConsentAt: '2026-09-01T00:00:00.000Z' as never,
      });
      await sut.updateRule(auth, rule.id, { archive: false });
      expect(mocks.classification.updateRule).toHaveBeenLastCalledWith(
        rule.id,
        expect.objectContaining({ archive: false, archiveConsentAt: null }),
      );
    });

    it('answers another account’s rule like a missing one', async () => {
      mocks.classification.getRule.mockResolvedValue(ruleOf());
      await expect(sut.updateRule(factory.auth(), newUuid(), { enabled: false })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('preview', () => {
    it('reports visual search as unavailable and reads nothing when phrases cannot be compared', async () => {
      const auth = factory.auth();
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: false } });

      const preview = await sut.preview(auth, { ...criteria, visualQueries: ['lake'], sampleSize: 100 });

      expect(preview).toEqual({ exact: false, sampled: 0, matched: 0, items: [], visualSearchAvailable: false });
      expect(mocks.classification.findMatches).not.toHaveBeenCalled();
      expect(mocks.classification.apply).not.toHaveBeenCalled();
    });

    it('never writes', async () => {
      const auth = factory.auth();
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-1']));
      mocks.classification.countEligible.mockResolvedValue(3);
      mocks.classification.countMatches.mockResolvedValue(1);

      await sut.preview(auth, { ...criteria, tagIds: ['tag-1'], sampleSize: 100 });

      expect(mocks.classification.apply).not.toHaveBeenCalled();
      expect(mocks.classification.decide).not.toHaveBeenCalled();
      expect(mocks.classification.createRule).not.toHaveBeenCalled();
    });
  });

  describe('plan', () => {
    it('sends a plan over 500 changes to a durable job and leaves manual decisions out', async () => {
      const auth = factory.auth();
      const rule = ruleOf({ ownerId: auth.user.id, action: ClassificationRuleAction.Tag });
      mocks.classification.getRule.mockResolvedValue(rule);
      const matches = Array.from({ length: 600 }, () => ({ assetId: newUuid(), score: null }));
      mocks.classification.findMatches.mockResolvedValue(matches);
      mocks.classification.getMatches.mockResolvedValue([
        {
          ruleId: rule.id,
          assetId: matches[0].assetId,
          decision: ClassificationMatchDecision.Rejected,
          score: null,
          tagContributed: false,
          archiveContributed: false,
          createdAt: '' as never,
          updatedAt: '' as never,
        },
      ]);
      mocks.classification.getUndoableAssetIds.mockResolvedValue([]);

      const plan = await sut.plan(auth, rule.id);

      expect(plan).toMatchObject({ matched: 600, added: 599, removed: 0, durable: true });
      expect(plan.assetIds).not.toContain(matches[0].assetId);
    });
  });

  describe('applyBulkBatch', () => {
    it('skips every item of a rule that is gone, disabled or not the job owner’s', async () => {
      const auth = factory.auth();
      const ids = [newUuid(), newUuid()];

      mocks.classification.getRule.mockResolvedValue(undefined);
      await expect(sut.applyBulkBatch(auth, newUuid(), ids)).resolves.toEqual(
        ids.map((id) => expect.objectContaining({ id, status: MediaOperationItemStatus.Skipped })),
      );

      mocks.classification.getRule.mockResolvedValue(ruleOf());
      await expect(sut.applyBulkBatch(auth, newUuid(), ids)).resolves.toEqual(
        ids.map((id) => expect.objectContaining({ id, status: MediaOperationItemStatus.Skipped })),
      );

      mocks.classification.getRule.mockResolvedValue(ruleOf({ ownerId: auth.user.id, enabled: false }));
      await expect(sut.applyBulkBatch(auth, newUuid(), ids)).resolves.toEqual(
        ids.map((id) => expect.objectContaining({ id, reasonKey: 'frameleaf_bulk_reason_rule_disabled' })),
      );
      expect(mocks.classification.apply).not.toHaveBeenCalled();
    });

    it('fails, never un-matches, when visual phrases cannot be compared (so a retry can finish it)', async () => {
      const auth = factory.auth();
      mocks.classification.getRule.mockResolvedValue(
        ruleOf({ ownerId: auth.user.id, visualQueries: ['lake'], tagIds: [] }),
      );
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: false } });

      const outcomes = await sut.applyBulkBatch(auth, newUuid(), ['a']);

      expect(outcomes).toEqual([expect.objectContaining({ id: 'a', status: MediaOperationItemStatus.Failed })]);
      expect(mocks.classification.apply).not.toHaveBeenCalled();
    });

    it('applies the rule to the batch', async () => {
      const auth = factory.auth();
      const rule = ruleOf({ ownerId: auth.user.id });
      mocks.classification.getRule.mockResolvedValue(rule);
      mocks.classification.findMatches.mockResolvedValue([{ assetId: 'a', score: null }]);

      await expect(sut.applyBulkBatch(auth, rule.id, ['a', 'b'])).resolves.toEqual([
        { id: 'a', status: MediaOperationItemStatus.Ok },
        { id: 'b', status: MediaOperationItemStatus.Ok },
      ]);
      expect(mocks.classification.apply).toHaveBeenCalledWith(rule, ['a', 'b'], new Map([['a', null]]));
    });
  });

  describe('evaluateAsset', () => {
    it('never throws, and keeps going after a rule fails', async () => {
      const first = ruleOf();
      const second = ruleOf();
      mocks.classification.getEnabledRules.mockResolvedValue([first, second]);
      mocks.classification.apply.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ ...emptyOutcome });

      await expect(sut.evaluateAsset('asset-1', first.ownerId)).resolves.toBeUndefined();
      expect(mocks.classification.apply).toHaveBeenCalledTimes(2);
    });
  });
});
