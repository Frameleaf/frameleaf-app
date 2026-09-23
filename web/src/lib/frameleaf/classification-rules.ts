/**
 * Smart album rules (FL-60), ported from `normalizeRule`, `ruleIsEmpty` and `RuleChips` in
 * `design/frameleaf/template/src/collections-data.mjs` and `CollectionHeader.jsx`.
 *
 * The prototype evaluates rules in the browser over sample data; production sends the draft to
 * `POST /classification/preview`, which reads and never writes. This module only shapes the draft,
 * decides when a preview is worth asking for, and turns a draft into the create and update bodies.
 * Archiving is never implied: it is sent only together with the person's explicit consent.
 */
import {
  ClassificationMediaType,
  ClassificationRuleAction,
  type ClassificationPreviewDto,
  type ClassificationRuleCreateDto,
  type ClassificationRuleResponseDto,
  type ClassificationRuleUpdateDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';

export const DEFAULT_THRESHOLD = 0.25;
export const DEFAULT_SAMPLE_SIZE = 500;
export const PREVIEW_DEBOUNCE_MS = 350;
const MAX_PHRASES = 10;
const MAX_IDS = 50;

export type RuleDraft = {
  personIds: string[];
  tagIds: string[];
  takenAfter: string | null;
  takenBefore: string | null;
  mediaType: ClassificationMediaType;
  visualQueries: string[];
  threshold: number;
  action: ClassificationRuleAction;
  /** The rule-owned tag a match receives. Empty when the rule only suggests. */
  tagName: string;
  archive: boolean;
  /** The person ticked the consent for archiving in this editing session. */
  archiveConsent: boolean;
  enabled: boolean;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: string | null | undefined) => (value && DAY.test(value) ? value : null);
const ids = (value: readonly string[] | undefined) => [...new Set((value ?? []).filter(Boolean))].slice(0, MAX_IDS);

export const parsePhrases = (text: string): string[] =>
  [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((phrase) => phrase.trim())
        .filter(Boolean),
    ),
  ].slice(0, MAX_PHRASES);

export const emptyRule = (action: ClassificationRuleAction = ClassificationRuleAction.Review): RuleDraft => ({
  personIds: [],
  tagIds: [],
  takenAfter: null,
  takenBefore: null,
  mediaType: ClassificationMediaType.Any,
  visualQueries: [],
  threshold: DEFAULT_THRESHOLD,
  action,
  tagName: '',
  archive: false,
  archiveConsent: false,
  enabled: true,
});

export const normalizeRule = (rule: Partial<RuleDraft>): RuleDraft => {
  const base = emptyRule(rule.action);
  const threshold = Number(rule.threshold ?? base.threshold);
  return {
    ...base,
    ...rule,
    personIds: ids(rule.personIds),
    tagIds: ids(rule.tagIds),
    takenAfter: day(rule.takenAfter),
    takenBefore: day(rule.takenBefore),
    mediaType: Object.values(ClassificationMediaType).includes(rule.mediaType as ClassificationMediaType)
      ? (rule.mediaType as ClassificationMediaType)
      : ClassificationMediaType.Any,
    visualQueries: parsePhrases((rule.visualQueries ?? []).join('\n')),
    threshold: Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : base.threshold,
    tagName: (rule.tagName ?? '').trim(),
    archive: rule.archive === true,
    archiveConsent: rule.archiveConsent === true,
    enabled: rule.enabled !== false,
  };
};

export const fromResponse = (rule: ClassificationRuleResponseDto): RuleDraft =>
  normalizeRule({
    personIds: rule.personIds,
    tagIds: rule.tagIds,
    takenAfter: rule.takenAfter,
    takenBefore: rule.takenBefore,
    mediaType: rule.mediaType,
    visualQueries: rule.visualQueries,
    threshold: rule.threshold,
    action: rule.action,
    tagName: rule.tag?.name ?? '',
    archive: rule.archive,
    // Consent already on record stays on record; turning archiving on again asks again.
    archiveConsent: rule.archive,
    enabled: rule.enabled,
  });

/** No criterion at all: the prototype refuses these, and so does the server. */
export const ruleIsEmpty = (rule: RuleDraft) =>
  rule.personIds.length === 0 &&
  rule.tagIds.length === 0 &&
  !rule.takenAfter &&
  !rule.takenBefore &&
  rule.mediaType === ClassificationMediaType.Any &&
  rule.visualQueries.length === 0;

export const dateOrderProblem = (rule: RuleDraft) =>
  !!rule.takenAfter && !!rule.takenBefore && rule.takenAfter > rule.takenBefore;

/** Why the rule cannot be saved yet, as an i18n key, or null. */
export const ruleProblem = (rule: RuleDraft): Translations | null => {
  if (ruleIsEmpty(rule)) {
    return 'frameleaf_rules_problem_empty';
  }
  if (dateOrderProblem(rule)) {
    return 'frameleaf_rules_problem_dates';
  }
  if (rule.action === ClassificationRuleAction.Tag && !rule.tagName) {
    return 'frameleaf_rules_problem_tag';
  }
  if (rule.archive && !rule.archiveConsent) {
    return 'frameleaf_rules_problem_archive_consent';
  }
  return null;
};

/** The read-only preview request for a draft. Only what decides the matches is sent. */
export const toPreview = (rule: RuleDraft, sampleSize = DEFAULT_SAMPLE_SIZE): ClassificationPreviewDto => ({
  personIds: rule.personIds,
  tagIds: rule.tagIds,
  takenAfter: rule.takenAfter,
  takenBefore: rule.takenBefore,
  mediaType: rule.mediaType,
  visualQueries: rule.visualQueries,
  threshold: rule.threshold,
  sampleSize,
});

/** Two drafts that match the same items ask for the same preview. */
export const previewKey = (rule: RuleDraft) => JSON.stringify(toPreview(rule));

export const toCreate = (
  rule: RuleDraft,
  album: { albumName: string; description?: string | null; icon?: string; parentId?: string | null },
): ClassificationRuleCreateDto => ({
  albumName: album.albumName,
  description: album.description ?? null,
  icon: album.icon,
  parentId: album.parentId ?? undefined,
  personIds: rule.personIds,
  tagIds: rule.tagIds,
  takenAfter: rule.takenAfter,
  takenBefore: rule.takenBefore,
  mediaType: rule.mediaType,
  visualQueries: rule.visualQueries,
  threshold: rule.threshold,
  action: rule.action,
  tagName: rule.action === ClassificationRuleAction.Tag ? rule.tagName : null,
  archive: rule.archive && rule.archiveConsent,
  ...(rule.archive && rule.archiveConsent && { archiveConsent: true }),
  enabled: rule.enabled,
});

export const toUpdate = (rule: RuleDraft, saved: ClassificationRuleResponseDto): ClassificationRuleUpdateDto => {
  const tagName = rule.action === ClassificationRuleAction.Tag ? rule.tagName : null;
  const turningArchiveOn = rule.archive && !saved.archive;
  return {
    personIds: rule.personIds,
    tagIds: rule.tagIds,
    takenAfter: rule.takenAfter,
    takenBefore: rule.takenBefore,
    mediaType: rule.mediaType,
    visualQueries: rule.visualQueries,
    threshold: rule.threshold,
    action: rule.action,
    ...(tagName !== (saved.tag?.name ?? null) && { tagName }),
    archive: rule.archive && (!turningArchiveOn || rule.archiveConsent),
    ...(turningArchiveOn && rule.archiveConsent && { archiveConsent: true }),
    enabled: rule.enabled,
  };
};

export type RuleChip = {
  icon: 'person' | 'tag' | 'date' | 'media' | 'visual' | 'archive';
  key: Translations;
  values: Record<string, string | number>;
};

/**
 * The chips a smart album shows for its rule, as the prototype's `RuleChips` does: people, tags, the
 * date range and the media type, plus the visual categories and archiving the production rule adds.
 */
export const ruleChips = (
  rule: RuleDraft,
  names: { people: Map<string, string>; tags: Map<string, string> },
  formatDay: (value: string) => string,
): RuleChip[] => {
  const chips: RuleChip[] = [];
  if (rule.personIds.length > 0) {
    chips.push({
      icon: 'person',
      key: 'frameleaf_rules_chip_list',
      values: { list: rule.personIds.map((id) => names.people.get(id) ?? '…').join(', ') },
    });
  }
  if (rule.tagIds.length > 0) {
    chips.push({
      icon: 'tag',
      key: 'frameleaf_rules_chip_list',
      values: { list: rule.tagIds.map((id) => names.tags.get(id) ?? '…').join(', ') },
    });
  }
  if (rule.takenAfter && rule.takenBefore) {
    chips.push({
      icon: 'date',
      key: 'frameleaf_rules_chip_between',
      values: { from: formatDay(rule.takenAfter), to: formatDay(rule.takenBefore) },
    });
  } else if (rule.takenAfter) {
    chips.push({ icon: 'date', key: 'frameleaf_rules_chip_from', values: { date: formatDay(rule.takenAfter) } });
  } else if (rule.takenBefore) {
    chips.push({ icon: 'date', key: 'frameleaf_rules_chip_until', values: { date: formatDay(rule.takenBefore) } });
  }
  if (rule.mediaType !== ClassificationMediaType.Any) {
    chips.push({
      icon: 'media',
      key:
        rule.mediaType === ClassificationMediaType.Video
          ? 'frameleaf_rules_videos_only'
          : 'frameleaf_rules_photos_only',
      values: {},
    });
  }
  if (rule.visualQueries.length > 0) {
    chips.push({
      icon: 'visual',
      key: 'frameleaf_rules_chip_visual',
      values: { list: rule.visualQueries.join(', '), confidence: Math.round(rule.threshold * 100) },
    });
  }
  if (rule.archive) {
    chips.push({ icon: 'archive', key: 'frameleaf_rules_chip_archive', values: {} });
  }
  return chips;
};

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "3 days ago", as the prototype's `timeAgo` reads the last check. Under a minute is "now". */
export const timeAgo = (iso: string, now = Date.now(), locale?: string) => {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) {
      return format.format(Math.trunc(seconds / size), unit);
    }
  }
  return format.format(0, 'second');
};
