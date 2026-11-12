import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { SearchFilter, SearchFilterBranch } from 'src/dtos/search.dto.js';
import {
  TIDY_UP_KINDS,
  TIDY_UP_STRICTNESS,
  TidyUpDecisionDto,
  TidyUpDecisionResponseDto,
  TidyUpKind,
  TidyUpKindStatusDto,
  TidyUpKindUpdateDto,
  TidyUpPageDto,
  TidyUpPageQueryDto,
  TidyUpStatusDto,
  TidyUpStrictness,
} from 'src/dtos/tidy-up.dto.js';
import {
  AlbumKind,
  ClassificationMatchDecision,
  ClassificationMediaType,
  ClassificationRuleAction,
  MediaOperationBulkAction,
} from 'src/enum.js';
import { ClassificationCareRule, ClassificationRepository } from 'src/repositories/classification.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { ClassificationService } from 'src/services/classification.service.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';

export const TIDIED_AWAY = 'Tidied away';

// ponytail: starting values, not yet calibrated. Measure on the messy review library (FL-1469) and adjust;
// they hold the cosine similarity a phrase must reach with the server's visual search model.
export const TIDY_UP_THRESHOLDS: Record<TidyUpStrictness, number> = { surer: 0.28, balanced: 0.25, more: 0.22 };
// Accidental shots have no phrases: strictness is how low the photo-quality check's technical score must be.
const TECHNICAL_CUTOFFS: Record<TidyUpStrictness, number> = { surer: 0.1, balanced: 0.15, more: 0.22 };

type Preset = {
  name: string;
  phrases: string[];
  filter: (strictness: TidyUpStrictness) => SearchFilter;
};

const NO_CAMERA: SearchFilter = { make: { eq: null }, model: { eq: null } };
const NO_PEOPLE: SearchFilter = { hasPeople: { eq: false } };

/**
 * One preset per kind. People are never in a meme, a shop photo, a forwarded image, a slide, a note or an
 * accidental shot that someone wants gone, so those kinds leave every photo with a face alone. Receipts,
 * documents and screenshots ignore faces: a screenshot of a video call is still a screenshot.
 */
export const TIDY_UP_PRESETS: Record<TidyUpKind, Preset> = {
  memes: {
    name: 'Memes',
    phrases: ['an internet meme with caption text', 'a funny image macro', 'a screenshot of a social media post'],
    filter: () => ({ ...NO_CAMERA, ...NO_PEOPLE }),
  },
  documents: {
    name: 'Receipts & documents',
    phrases: ['a paper receipt', 'a paper document', 'an invoice or bill', 'a printed form or ticket'],
    filter: () => ({}),
  },
  screenshots: {
    name: 'Screenshots',
    phrases: [],
    filter: () => ({ isScreenshot: { eq: true } }),
  },
  shop: {
    name: 'Shop & product photos',
    phrases: ['furniture in a store showroom', 'a product on a store shelf', 'a price tag in a shop'],
    filter: () => ({ ...NO_PEOPLE }),
  },
  chat: {
    name: 'Forwarded chat images',
    phrases: [],
    // WhatsApp (IMG-20240101-WA0001), Messenger (received_…), Facebook (FB_IMG_…) and Telegram (photo_2024-…)
    filter: () => ({
      ...NO_CAMERA,
      ...NO_PEOPLE,
      or: [
        { originalFileName: { like: '-WA0' } },
        { originalFileName: { startsWith: 'received_' } },
        { originalFileName: { startsWith: 'FB_IMG_' } },
        { originalFileName: { startsWith: 'photo_20' } },
      ],
    }),
  },
  slides: {
    name: 'Whiteboards & slides',
    phrases: ['a whiteboard with writing', 'a presentation slide on a screen', 'a photo of a computer monitor'],
    filter: () => ({ ...NO_PEOPLE }),
  },
  notes: {
    name: 'Notes to self',
    phrases: ['a parking garage level sign', 'a serial number label', 'a QR code', 'a handwritten note'],
    filter: () => ({ ...NO_PEOPLE }),
  },
  accidental: {
    name: 'Accidental shots',
    phrases: [],
    filter: (strictness) => ({ ...NO_PEOPLE, technicalScore: { lt: TECHNICAL_CUTOFFS[strictness] } }),
  },
};

/**
 * Never suggested, whatever they look like: favourites and photos with stars (a rejected −1 still
 * counts as unrated). Built here, never taken from a client. "No stars" needs an OR (empty, or below 1),
 * so it is spread over the preset's own OR branches.
 */
export const guarded = (filter: SearchFilter): SearchFilter => {
  const unrated: SearchFilterBranch[] = [{ rating: { eq: null } }, { rating: { lt: 1 } }];
  const branches = filter.or ?? [{}];
  return {
    ...filter,
    isFavorite: { eq: false },
    or: branches.flatMap((branch) => unrated.map((rating) => ({ ...branch, ...rating }))),
  };
};

/** The strictness a rule was saved with; every kind stores it in `threshold`, phrases or not. */
const strictnessOf = (threshold: number): TidyUpStrictness => {
  const distance = (strictness: TidyUpStrictness) => Math.abs(TIDY_UP_THRESHOLDS[strictness] - threshold);
  return TIDY_UP_STRICTNESS.toSorted((a, b) => distance(a) - distance(b))[0];
};

/**
 * Tidy up (FL-1469): memes, receipts, screenshots and other clutter suggested for the Archive.
 *
 * Each kind is one of the owner's classification rules (FL-60) with `careKind` set, its album inside the
 * "Tidied away" collection. The rule archives only with consent (turning a kind on is that consent) and
 * only suggests, unless the owner turned on Archive automatically for that kind. Nothing is ever deleted.
 */
@Injectable()
export class TidyUpService {
  constructor(
    private logger: LoggingRepository,
    private repository: ClassificationRepository,
    private classification: ClassificationService,
    private albums: AlbumService,
    private mediaOperations: MediaOperationService,
  ) {
    this.logger.setContext(TidyUpService.name);
  }

  async getStatus(auth: AuthDto): Promise<TidyUpStatusDto> {
    const [rules, counts, { visualSearchAvailable }] = await Promise.all([
      this.repository.getCareRules(auth.user.id),
      this.repository.countCare(auth.user.id),
      this.classification.getSettings(),
    ]);
    const byKind = new Map(rules.map((rule) => [rule.careKind, rule]));
    return {
      kinds: TIDY_UP_KINDS.map((kind) => this.present(kind, byKind.get(kind), visualSearchAvailable, counts.waiting)),
      waiting: counts.waitingTotal,
      tidiedAway: counts.tidied,
      collectionId: rules.find((rule) => rule.parentId)?.parentId ?? null,
    };
  }

  async setKind(auth: AuthDto, kind: TidyUpKind, dto: TidyUpKindUpdateDto): Promise<TidyUpKindStatusDto> {
    const preset = TIDY_UP_PRESETS[kind];
    const rules = await this.repository.getCareRules(auth.user.id);
    const rule = rules.find((candidate) => candidate.careKind === kind);
    const { visualSearchAvailable } = await this.classification.getSettings();

    const enabled = dto.enabled ?? rule?.enabled ?? true;
    const strictness = dto.strictness ?? (rule ? strictnessOf(rule.threshold) : 'balanced');
    // Archive automatically is off until the owner turns it on for this kind.
    const automatic = dto.automatic ?? rule?.action === ClassificationRuleAction.Tag;
    if (enabled && preset.phrases.length > 0 && !visualSearchAvailable) {
      throw new BadRequestException('Turn on Visual search to look for this kind');
    }

    const criteria = {
      filter: guarded(preset.filter(strictness)),
      visualQueries: preset.phrases,
      threshold: TIDY_UP_THRESHOLDS[strictness],
      action: automatic ? ClassificationRuleAction.Tag : ClassificationRuleAction.Review,
      tagName: automatic ? `${TIDIED_AWAY}/${preset.name}` : null,
    };

    let id = rule?.id;
    if (!rule) {
      if (!enabled) {
        return this.present(kind, undefined, visualSearchAvailable, new Map());
      }
      const created = await this.classification.createRule(auth, {
        ...criteria,
        albumName: preset.name,
        parentId: await this.collectionId(auth, rules),
        personIds: [],
        tagIds: [],
        takenAfter: null,
        takenBefore: null,
        mediaType: ClassificationMediaType.Photo,
        archive: true,
        archiveConsent: true,
        enabled,
      });
      // ponytail: two first-time requests for one kind at once — the second fails here on the unique key and
      // leaves an ordinary smart album behind; the page sends one request per switch, so it is not worth a lock.
      await this.repository.setCareKind(created.id, kind);
      id = created.id;
    } else {
      await this.classification.updateRule(auth, rule.id, { ...criteria, enabled });
    }

    // Look through the library when a kind is turned on or its strictness changes, but never while it
    // archives automatically: then only new photos are archived, and what was already found waits for review.
    const rescan = enabled && !automatic && (!rule || !rule.enabled || dto.strictness !== undefined);
    if (rescan) {
      await this.scan(auth, id!);
    }

    const [after, counts] = await Promise.all([
      this.repository.getCareRules(auth.user.id),
      this.repository.countCare(auth.user.id),
    ]);
    return this.present(
      kind,
      after.find((candidate) => candidate.careKind === kind),
      visualSearchAvailable,
      counts.waiting,
    );
  }

  getSuggestions(auth: AuthDto, dto: TidyUpPageQueryDto): Promise<TidyUpPageDto> {
    return this.page(auth, 'waiting', dto);
  }

  getTidiedAway(auth: AuthDto, dto: TidyUpPageQueryDto): Promise<TidyUpPageDto> {
    return this.page(auth, 'tidied', dto);
  }

  /**
   * archive: accept every Tidy up suggestion on these photos. keep: reject on every Tidy up rule holding
   * them, which takes them out of the Archive if a rule put them there and never suggests them again.
   * undo: an archive the owner made goes back up for review.
   */
  async decide(auth: AuthDto, { assetIds, decision }: TidyUpDecisionDto): Promise<TidyUpDecisionResponseDto> {
    const [target, from] = {
      archive: [ClassificationMatchDecision.Accepted, [ClassificationMatchDecision.Suggested]],
      keep: [
        ClassificationMatchDecision.Rejected,
        [
          ClassificationMatchDecision.Suggested,
          ClassificationMatchDecision.Accepted,
          ClassificationMatchDecision.Matched,
        ],
      ],
      undo: [ClassificationMatchDecision.Suggested, [ClassificationMatchDecision.Accepted]],
    }[decision] as [
      (
        | ClassificationMatchDecision.Accepted
        | ClassificationMatchDecision.Rejected
        | ClassificationMatchDecision.Suggested
      ),
      ClassificationMatchDecision[],
    ];

    const done = new Set<string>();
    // One rule at a time: a photo two kinds archived leaves the Archive only once neither holds it.
    for (const rule of await this.repository.getCareRules(auth.user.id)) {
      const ids = (await this.repository.getMatches(rule.id, assetIds))
        .filter((match) => from.includes(match.decision))
        .map((match) => match.assetId);
      if (ids.length === 0) {
        continue;
      }
      const outcome = await this.repository.decide(rule, ids, target);
      await this.classification.emitTagEvents(rule.ownerId, outcome);
      for (const id of ids) {
        done.add(id);
      }
    }
    return { updated: done.size, skipped: assetIds.length - done.size };
  }

  /* ---------------- internals ---------------- */

  private async page(auth: AuthDto, list: 'waiting' | 'tidied', dto: TidyUpPageQueryDto): Promise<TidyUpPageDto> {
    const offset = (dto.page - 1) * dto.size;
    const { total, items } = await this.repository.getCarePage(auth.user.id, list, {
      kind: dto.kind,
      offset,
      limit: dto.size,
    });
    return { total, items, nextPage: offset + items.length < total ? dto.page + 1 : null };
  }

  /** Bring the rule in line with the library: inline up to 500 changes, a durable bulk job beyond. */
  private async scan(auth: AuthDto, ruleId: string) {
    try {
      const plan = await this.classification.plan(auth, ruleId);
      if (plan.durable) {
        await this.mediaOperations.createBulk(auth, {
          action: MediaOperationBulkAction.ApplyClassificationRule,
          assetIds: plan.assetIds,
          payload: { classificationRuleId: ruleId },
          submittedTotal: plan.assetIds.length,
          truncated: plan.truncated,
        });
      } else {
        await this.classification.apply(auth, ruleId, { assetIds: plan.assetIds });
      }
    } catch (error) {
      // The kind is saved either way; new photos are checked as they arrive and the page can look again.
      this.logger.warn(`Tidy up could not look through the library for rule ${ruleId}: ${String(error)}`);
    }
  }

  /** The "Tidied away" collection the kinds' albums sit in: the one already in use, or a new one. */
  private async collectionId(auth: AuthDto, rules: ClassificationCareRule[]): Promise<string> {
    const existing = rules.find((rule) => rule.parentId)?.parentId;
    if (existing) {
      return existing;
    }
    const collection = await this.albums.create(auth, { albumName: TIDIED_AWAY, kind: AlbumKind.Collection });
    return collection.id;
  }

  private present(
    kind: TidyUpKind,
    rule: ClassificationCareRule | undefined,
    visualSearchAvailable: boolean,
    waiting: Map<string, number>,
  ): TidyUpKindStatusDto {
    const visual = TIDY_UP_PRESETS[kind].phrases.length > 0;
    return {
      kind,
      enabled: !!rule?.enabled,
      strictness: rule ? strictnessOf(rule.threshold) : 'balanced',
      automatic: rule?.action === ClassificationRuleAction.Tag,
      visual,
      available: !visual || visualSearchAvailable,
      waiting: waiting.get(kind) ?? 0,
      albumId: rule?.albumId ?? null,
    };
  }
}
