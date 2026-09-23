import { ClassificationMediaType, ClassificationRuleAction, type ClassificationRuleResponseDto } from '@immich/sdk';
import {
  emptyRule,
  fromResponse,
  normalizeRule,
  parsePhrases,
  previewKey,
  ruleChips,
  ruleIsEmpty,
  ruleProblem,
  timeAgo,
  toCreate,
  toPreview,
  toUpdate,
} from '$lib/frameleaf/classification-rules';

const saved = (overrides: Partial<ClassificationRuleResponseDto> = {}): ClassificationRuleResponseDto => ({
  id: 'rule-1',
  albumId: 'album-1',
  albumName: 'Lake days',
  enabled: true,
  personIds: [],
  tagIds: ['tag-lake'],
  takenAfter: null,
  takenBefore: null,
  mediaType: ClassificationMediaType.Any,
  visualQueries: [],
  threshold: 0.25,
  action: ClassificationRuleAction.Review,
  tag: null,
  archive: false,
  archiveConsentAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  lastAppliedAt: null,
  counts: { matched: 0, suggested: 0, accepted: 0, rejected: 0 },
  ...overrides,
});

describe('classification rules', () => {
  it('treats a rule without criteria as empty, like the prototype', () => {
    expect(ruleIsEmpty(emptyRule())).toBe(true);
    expect(ruleProblem(emptyRule())).toBe('frameleaf_rules_problem_empty');
    expect(ruleIsEmpty(normalizeRule({ mediaType: ClassificationMediaType.Video }))).toBe(false);
  });

  it('normalizes dates, duplicates, phrases and the threshold', () => {
    const rule = normalizeRule({
      tagIds: ['a', 'a', 'b'],
      takenAfter: 'not a day',
      visualQueries: [' lake ', 'lake', ''],
      threshold: 7,
    });
    expect(rule).toMatchObject({ tagIds: ['a', 'b'], takenAfter: null, visualQueries: ['lake'], threshold: 1 });
    expect(parsePhrases('lake, sunset\nlake')).toEqual(['lake', 'sunset']);
  });

  it('asks for a new preview when the threshold changes, and not for anything else', () => {
    const rule = normalizeRule({ visualQueries: ['lake'], threshold: 0.25 });
    expect(previewKey({ ...rule, tagName: 'Lake', action: ClassificationRuleAction.Tag })).toBe(previewKey(rule));
    expect(previewKey({ ...rule, archive: true })).toBe(previewKey(rule));
    expect(previewKey({ ...rule, threshold: 0.3 })).not.toBe(previewKey(rule));
    expect(toPreview(rule, 200)).toMatchObject({ threshold: 0.25, sampleSize: 200 });
  });

  describe('archive consent', () => {
    it('cannot be saved with archiving until the person consents', () => {
      const rule = normalizeRule({ tagIds: ['t'], archive: true });
      expect(ruleProblem(rule)).toBe('frameleaf_rules_problem_archive_consent');
      expect(toCreate(rule, { albumName: 'Receipts' })).toMatchObject({ archive: false });
      expect(toCreate(rule, { albumName: 'Receipts' })).not.toHaveProperty('archiveConsent');

      const consented = { ...rule, archiveConsent: true };
      expect(ruleProblem(consented)).toBeNull();
      expect(toCreate(consented, { albumName: 'Receipts' })).toMatchObject({ archive: true, archiveConsent: true });
    });

    it('asks again when archiving is turned back on, and keeps consent already on record', () => {
      const off = saved();
      const draft = { ...fromResponse(off), archive: true };
      expect(draft.archiveConsent).toBe(false);
      expect(toUpdate(draft, off)).toMatchObject({ archive: false });
      expect(toUpdate({ ...draft, archiveConsent: true }, off)).toMatchObject({ archive: true, archiveConsent: true });

      const on = saved({ archive: true, archiveConsentAt: '2026-09-01T00:00:00.000Z' });
      const kept = fromResponse(on);
      expect(kept.archiveConsent).toBe(true);
      expect(toUpdate(kept, on)).toMatchObject({ archive: true });
      expect(toUpdate(kept, on)).not.toHaveProperty('archiveConsent');
    });
  });

  it('needs a tag name before a rule may add tags, and only sends a changed tag name', () => {
    const rule = normalizeRule({ tagIds: ['t'], action: ClassificationRuleAction.Tag });
    expect(ruleProblem(rule)).toBe('frameleaf_rules_problem_tag');
    const tagged = saved({ action: ClassificationRuleAction.Tag, tag: { id: 'x', name: 'Lake' } });
    expect(toUpdate(fromResponse(tagged), tagged)).not.toHaveProperty('tagName');
    expect(toUpdate({ ...fromResponse(tagged), tagName: 'Water' }, tagged)).toMatchObject({ tagName: 'Water' });
  });

  it('describes the rule as chips', () => {
    const rule = normalizeRule({
      personIds: ['p'],
      tagIds: ['t'],
      takenAfter: '2026-08-01',
      mediaType: ClassificationMediaType.Photo,
      visualQueries: ['lake'],
      threshold: 0.3,
      archive: true,
    });
    const chips = ruleChips(rule, { people: new Map([['p', 'Emma']]), tags: new Map([['t', 'lake']]) }, (d) => d);
    expect(chips.map(({ icon }) => icon)).toEqual(['person', 'tag', 'date', 'media', 'visual', 'archive']);
    expect(chips[0].values).toEqual({ list: 'Emma' });
    expect(chips[2]).toMatchObject({ key: 'frameleaf_rules_chip_from', values: { date: '2026-08-01' } });
    expect(chips[4].values).toEqual({ list: 'lake', confidence: 30 });
  });

  it('reads the last check as relative time, like the prototype', () => {
    const now = Date.parse('2026-09-23T12:00:00Z');
    expect(timeAgo('2026-09-20T12:00:00Z', now, 'en')).toBe('3 days ago');
    expect(timeAgo('2026-09-23T11:59:50Z', now, 'en')).toBe('now');
  });
});
