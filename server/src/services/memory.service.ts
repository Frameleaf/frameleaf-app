import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { isUndefined, omitBy } from 'lodash-es';
import { DateTime } from 'luxon';
import { basename, parse } from 'node:path';
import { pipeline } from 'node:stream/promises';
import sanitize from 'sanitize-filename';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { MemoryCurationFilter, MemoryShowLessRow } from 'src/repositories/memory.repository.js';
import type { JobOf } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { Memory, MemoryExport } from 'src/database.js';
import { OnJob } from 'src/decorators.js';
import { BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import {
  MemoryCreateDto,
  MemoryExportCreateDto,
  MemoryExportResponseDto,
  MemoryResponseDto,
  MemorySearchDto,
  MemoryShowLessDto,
  MemoryShowLessResponseDto,
  MemoryUpdateDto,
  applyMemoryAssetOrder,
  isTerminalExportStatus,
  mapMemory,
  mapMemoryExport,
} from 'src/dtos/memory.dto.js';
import {
  AssetVisibility,
  DatabaseLock,
  JobName,
  JobStatus,
  MemoryExportFormat,
  MemoryExportStatus,
  MemoryShowLessKind,
  MemoryType,
  Permission,
  PushEventType,
  QueueName,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { ImmichReadStream } from 'src/repositories/storage.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { MemoryHighlightService } from 'src/services/memory-highlight.service.js';
import { addAssets, removeAssets } from 'src/utils/asset.util.js';
import {
  type HiddenContentQueryOptions,
  getHiddenContentQueryOptions,
  isSuppressedWhileLocked,
} from 'src/utils/hidden-content.js';
import {
  birthdayAge,
  birthdayOn,
  calendarDayWindow,
  diversifyByMonth,
  diversifyByYear,
  groupEventStories,
  groupPetStories,
  placeLabel,
  suppressBursts,
} from 'src/utils/memory-story.js';
import { findOrFail } from 'src/utils/misc.js';

const DAYS = 3;

/** how far back a generation pass looks for events it has not grouped yet */
const EVENT_STORY_LOOKBACK_DAYS = 45;

/** an event is only turned into a story once its last day is this far behind us */
const EVENT_STORY_SETTLE_DAYS = 2;

/** a year-in-review recap is generated this many days into the following year */
const YEAR_IN_REVIEW_DELAY_DAYS = 7;

/** how long a finished export archive stays on disk before it is reclaimed */
const EXPORT_TTL_HOURS = 24;

/** a run that has not been touched for this long is assumed to have lost its worker */
const EXPORT_STALE_MINUTES = 60;

/** the most assets one export may carry */
const EXPORT_MAX_ASSETS = 2000;

/** a year with fewer assets than this does not get a recap */
const MIN_YEAR_IN_REVIEW_ASSETS = 20;

/** a person or pet needs this many of the owner's items in a year for a recap (FL-62) */
const MIN_PERSON_RECAP_ASSETS = 20;

/** at most this many people and pets get a recap per owner per year (FL-62) */
const MAX_PERSON_RECAPS = 5;

/** a birthday memory needs at least this many photos of the person or pet (FL-62) */
const MIN_BIRTHDAY_ASSETS = 3;

/** the most items one birthday or recap memory keeps (FL-62) */
const MAX_SUBJECT_MEMORY_ASSETS = 60;

/** an "on this day" year keeps at most this many items after burst suppression (FL-62) */
const MAX_ON_THIS_DAY_ASSETS = 20;

/** how often the running export re-reads its own row to notice a cancel */
const EXPORT_CANCEL_POLL_MS = 500;

/**
 * A stable, human-readable name for an export, captured when it is requested. It is what
 * the archive is called on download and what the Activity page shows for a memory that was
 * meanwhile renamed or deleted. Clients still render their own localized memory titles;
 * this is deliberately data, not a translated string.
 */
const buildExportTitle = (memory: { type: string; data: unknown }): string => {
  const data = (memory.data ?? {}) as Record<string, unknown>;

  if (memory.type === MemoryType.EventStory) {
    const label = typeof data.title === 'string' ? data.title : undefined;
    const range = [data.startDate, data.endDate].filter((value) => typeof value === 'string').join(' - ');
    return label ?? (range || 'Memory');
  }

  if (typeof data.year === 'number') {
    return String(data.year);
  }

  return 'Memory';
};

/** jsonb comes back as whatever was written; only string ids are ever honoured */
const normalizeAssetIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
};

/** FL-57: the memory types whose data names one person or pet */
const SUBJECT_MEMORY_TYPES = [MemoryType.PetStory, MemoryType.Birthday, MemoryType.PersonRecap] as const;

/** The person or pet a pet story, birthday or recap names, if any. */
const memorySubject = (memory: Memory): { kind: 'person' | 'pet'; id: string } | undefined => {
  const data = (memory.data ?? {}) as { petId?: unknown; subject?: unknown; subjectId?: unknown };
  if (memory.type === MemoryType.PetStory) {
    return typeof data.petId === 'string' ? { kind: 'pet', id: data.petId } : undefined;
  }
  if (memory.type !== MemoryType.Birthday && memory.type !== MemoryType.PersonRecap) {
    return undefined;
  }
  const kind = data.subject === 'person' || data.subject === 'pet' ? data.subject : undefined;
  return kind && typeof data.subjectId === 'string' ? { kind, id: data.subjectId } : undefined;
};

@Injectable()
export class MemoryService extends BaseService {
  /** FL-194: highlight videos, rendered through Studio's render pipeline. */
  @Inject(MemoryHighlightService)
  private highlights!: MemoryHighlightService;

  @OnJob({ name: JobName.MemoryGenerate, queue: QueueName.BackgroundTask })
  async onMemoriesCreate() {
    const users = await this.userRepository.getList({ withDeleted: false });

    await this.databaseRepository.withLock(DatabaseLock.MemoryCreation, async () => {
      const state = await this.systemMetadataRepository.get(SystemMetadataKey.MemoriesState);
      const start = DateTime.utc().startOf('day').minus({ days: DAYS });
      const lastOnThisDayDate = state?.lastOnThisDayDate ? DateTime.fromISO(state.lastOnThisDayDate) : start;

      // generate a memory +/- X days from today
      for (let i = 0; i <= DAYS * 2; i++) {
        const target = start.plus({ days: i });
        if (lastOnThisDayDate >= target) {
          continue;
        }

        this.logger.log(`Creating memories for ${target.toISO()}`);
        try {
          await Promise.all(
            users.map(async (owner) => {
              const rules = await this.memoryRepository.getShowLess(owner.id);
              await this.createOnThisDayMemories(owner.id, target, rules);
              await this.createBirthdayMemories(owner.id, target, rules);
            }),
          );
        } catch (error) {
          this.logger.error(`Failed to create memories for ${target.toISO()}: ${error}`);
        }
        // update system metadata even when there is an error to minimize the chance of duplicates
        await this.systemMetadataRepository.set(SystemMetadataKey.MemoriesState, {
          ...state,
          lastOnThisDayDate: target.toISO(),
        });
      }

      await this.createEventStories(users);
      await this.createYearInReviews(users);
      await this.createPetStories(users);
      await this.createPersonRecaps(users);
    });

    await this.announceNewMemories();
  }

  /**
   * FL-228: one push per owner whose memories became visible since the last nightly run. Their items
   * are offered as the preview; the push service drops Locked and sensitive ones. Never fails the run.
   */
  private async announceNewMemories() {
    const now = new Date();
    try {
      const summaries = await this.memoryRepository.getNewlyVisibleSummaries(
        new Date(now.getTime() - 24 * 60 * 60 * 1000),
        now,
      );
      for (const { ownerId, count, assetIds } of summaries) {
        await this.eventRepository.emit('PushNotify', {
          type: PushEventType.Memories,
          userIds: [ownerId],
          title: 'Memories',
          body: count === 1 ? 'A new memory is ready' : `${count} new memories are ready`,
          systemTemplate:
            count === 1
              ? { version: 1, key: 'memories-one', args: {} }
              : { version: 1, key: 'memories-many', args: { count } },
          data: { count },
          assetIds,
          dedupeKey: `memories/${ownerId}/${now.toISOString().slice(0, 10)}`,
        });
      }
    } catch (error) {
      this.logger.warn(`Could not announce new memories: ${error}`);
    }
  }

  /**
   * Event stories (FL-62): a user's assets grouped into multi-day events by their local
   * capture time and place, written as ordinary memories of type `event_story` so the
   * existing memories API serves them with no second read path.
   *
   * Everything is per owner. The grouping query is owner-scoped, the memory is created with
   * that owner's id, and no cross-user query exists — a shared album cannot leak into
   * somebody else's story.
   */
  private async createEventStories(users: { id: string }[]) {
    // `localDateTime` is the owner's wall clock, so the window is expressed in the fixed
    // `utc` zone: that is how the column stores local time, and it keeps the boundary
    // identical whatever the server's own zone is.
    const today = DateTime.utc().startOf('day');
    const until = today.minus({ days: EVENT_STORY_SETTLE_DAYS }).endOf('day');
    const from = today.minus({ days: EVENT_STORY_LOOKBACK_DAYS }).startOf('day');

    for (const { id: ownerId } of users) {
      try {
        await this.createEventStoriesForOwner(ownerId, from, until);
      } catch (error) {
        this.logger.error(`Failed to create event stories for ${ownerId}: ${error}`);
      }
    }
  }

  private async createEventStoriesForOwner(ownerId: string, from: DateTime, until: DateTime) {
    const rules = await this.memoryRepository.getShowLess(ownerId);
    if (rules.some(({ kind, value }) => kind === MemoryShowLessKind.Type && value === MemoryType.EventStory)) {
      return;
    }
    const candidates = await this.assetRepository.getEventStoryCandidates(ownerId, from.toJSDate(), until.toJSDate());
    const stories = groupEventStories(candidates);
    if (stories.length === 0) {
      return;
    }

    // Duplicate suppression: a story whose start instant already has a memory — including
    // one the owner deleted — is not created again.
    const existing = await this.memoryRepository.getExistingMemoryDates(
      ownerId,
      MemoryType.EventStory,
      from.toJSDate(),
      until.toJSDate(),
    );
    const taken = new Set(existing.map((date) => date.getTime()));

    for (const story of stories) {
      if (taken.has(story.startAt.getTime())) {
        continue;
      }

      const label = placeLabel(story.place);
      await this.memoryRepository.create(
        {
          ownerId,
          type: MemoryType.EventStory,
          data: {
            kind: 'event_story',
            year: Number(story.startDate.slice(0, 4)),
            startDate: story.startDate,
            endDate: story.endDate,
            dayCount: story.dayCount,
            assetCount: story.totalAssets,
            ...(story.place && { place: story.place }),
            ...(label && { title: label }),
          },
          memoryAt: story.startAt.toISOString(),
          // the story becomes current the moment it is generated; there is no natural
          // recurring day for it, so it is never hidden and the usual 30-day cleanup of
          // unsaved memories applies
          showAt: story.endAt.toISOString(),
        },
        new Set(story.assetIds),
      );
      taken.add(story.startAt.getTime());
    }
  }

  /**
   * Year-in-review recaps (FL-62), generated once per owner per calendar year a week into
   * the following year, using the owner's local capture time for the year boundary.
   */
  private async createYearInReviews(users: { id: string }[]) {
    const now = DateTime.utc();
    const year = now.minus({ days: YEAR_IN_REVIEW_DELAY_DAYS }).year - 1;
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.MemoriesState);

    if (state?.lastYearInReviewYear !== undefined && state.lastYearInReviewYear >= year) {
      return;
    }

    for (const { id: ownerId } of users) {
      try {
        await this.createYearInReviewForOwner(ownerId, year);
      } catch (error) {
        this.logger.error(`Failed to create the ${year} recap for ${ownerId}: ${error}`);
      }
    }

    await this.systemMetadataRepository.set(SystemMetadataKey.MemoriesState, {
      ...(state ?? { lastOnThisDayDate: now.toISO()! }),
      lastYearInReviewYear: year,
    });
  }

  private async createYearInReviewForOwner(ownerId: string, year: number) {
    const memoryAt = DateTime.fromObject({ year, month: 12, day: 31 }, { zone: 'utc' }).endOf('day');
    const existing = await this.memoryRepository.getExistingMemoryDates(
      ownerId,
      MemoryType.YearInReview,
      memoryAt.startOf('day').toJSDate(),
      memoryAt.toJSDate(),
    );
    if (existing.length > 0) {
      return;
    }

    const rules = await this.memoryRepository.getShowLess(ownerId);
    if (rules.some(({ kind, value }) => kind === MemoryShowLessKind.Type && value === MemoryType.YearInReview)) {
      return;
    }

    const candidates = await this.assetRepository.getYearInReviewCandidates(ownerId, year);
    if (candidates.length < MIN_YEAR_IN_REVIEW_ASSETS) {
      return;
    }

    const months = new Set(candidates.map(({ month }) => month));

    await this.memoryRepository.create(
      {
        ownerId,
        type: MemoryType.YearInReview,
        data: {
          kind: 'year_in_review',
          year,
          assetCount: candidates.length,
          monthCount: months.size,
        },
        memoryAt: memoryAt.toISO()!,
        showAt: memoryAt.toISO()!,
      },
      new Set(candidates.map(({ id }) => id)),
    );
  }

  /**
   * Pet stories (FL-58): "Moments with {name}" for each named pet the owner confirmed in enough
   * photos of one local month. The last full month and the current one are looked at, so a story
   * appears within a day of the month collecting enough photos; each pet and month gets one story,
   * never again once deleted.
   */
  private async createPetStories(users: { id: string }[]) {
    const now = DateTime.utc();
    const from = now.minus({ months: 1 }).startOf('month');
    const until = now.endOf('day');

    for (const { id: ownerId } of users) {
      try {
        await this.createPetStoriesForOwner(ownerId, from, until);
      } catch (error) {
        this.logger.error(`Failed to create pet stories for ${ownerId}: ${error}`);
      }
    }
  }

  private async createPetStoriesForOwner(ownerId: string, from: DateTime, until: DateTime) {
    // FL-62: none for a pet (or for pet stories at all) the owner asked to see less of
    const rules = await this.memoryRepository.getShowLess(ownerId);
    if (rules.some(({ kind, value }) => kind === MemoryShowLessKind.Type && value === MemoryType.PetStory)) {
      return;
    }
    const lessOf = new Set(rules.filter(({ kind }) => kind === MemoryShowLessKind.Pet).map(({ value }) => value));
    const candidates = await this.memoryRepository.getPetStoryCandidates(ownerId, from.toJSDate(), until.toJSDate());
    const stories = groupPetStories(candidates).filter(({ petId }) => !lessOf.has(petId));
    if (stories.length === 0) {
      return;
    }

    const taken = await this.memoryRepository.getPetStoryKeys(ownerId, from.toJSDate(), until.toJSDate());
    for (const story of stories) {
      const key = `${story.petId}:${story.month}`;
      if (taken.has(key)) {
        continue;
      }
      const memoryAt = DateTime.fromFormat(story.month, 'yyyy-MM', { zone: 'utc' }).startOf('month');
      await this.memoryRepository.create(
        {
          ownerId,
          type: MemoryType.PetStory,
          data: {
            kind: 'pet_story',
            year: memoryAt.year,
            month: story.month,
            petId: story.petId,
            name: story.name,
            species: story.species,
            assetCount: story.assetCount,
          },
          memoryAt: memoryAt.toISO()!,
          showAt: DateTime.utc().startOf('day').toISO()!,
        },
        new Set(story.assetIds),
      );
      taken.add(key);
    }
  }

  /**
   * A memory that names a person or pet reads as they are now: a pet story (FL-58), a birthday or a
   * recap (FL-57). A renamed person or pet shows the new name, so a memory made before a rename never
   * shows the old one, and one about a person or pet that was deleted or merged away, hidden, or is
   * suppressed in a session that is not unlocked is left out, as they are themselves.
   */
  private async withCurrentSubjects(auth: AuthDto, memories: Memory[]): Promise<Memory[]> {
    const subjects = new Map(
      memories.flatMap((memory) => {
        const subject = memorySubject(memory);
        return subject ? [[memory.id, subject] as const] : [];
      }),
    );
    if (subjects.size === 0) {
      return memories;
    }
    const idsOf = (kind: 'person' | 'pet') => [
      ...new Set(
        subjects
          .values()
          .filter((subject) => subject.kind === kind)
          .map(({ id }) => id),
      ),
    ];
    const [personIds, petIds] = [idsOf('person'), idsOf('pet')];
    const [people, pets] = await Promise.all([
      personIds.length > 0 ? this.memoryRepository.getStoryPeople(auth.user.id, personIds) : [],
      petIds.length > 0 ? this.memoryRepository.getStoryPets(auth.user.id, petIds) : [],
    ]);
    const current = {
      person: new Map(people.map((person) => [person.id, person] as const)),
      pet: new Map(pets.map((pet) => [pet.id, pet] as const)),
    };
    return memories.flatMap((memory) => {
      const subject = subjects.get(memory.id);
      if (!subject) {
        return [memory];
      }
      const found = current[subject.kind].get(subject.id);
      if (!found || found.isHidden || isSuppressedWhileLocked(auth, subject.kind, found.id)) {
        return [];
      }
      if (memory.type !== MemoryType.PetStory && !found.name) {
        return [];
      }
      const species = memory.type === MemoryType.PetStory && 'species' in found ? { species: found.species } : {};
      return [{ ...memory, data: { ...(memory.data as object), name: found.name, ...species } } as Memory];
    });
  }

  private async createOnThisDayMemories(ownerId: string, target: DateTime, rules: MemoryShowLessRow[] = []) {
    const shownLess = (type: MemoryType, date: string) =>
      rules.some(
        ({ kind, value }) =>
          (kind === MemoryShowLessKind.Type && value === type) || (kind === MemoryShowLessKind.Date && value === date),
      );
    if (shownLess(MemoryType.OnThisDay, target.toFormat('MM-dd'))) {
      return;
    }
    const showAt = target.startOf('day').toISO();
    const hideAt = target.endOf('day').toISO();
    const memories = await this.assetRepository.getByDayOfYear([ownerId], target);
    await Promise.all(
      memories.map(({ year, assets }) => {
        // FL-62: one moment of a burst stands for the rest, so a year is not twenty frames of the same second
        const kept = suppressBursts(
          (assets as { id: string; localDateTime: Date | string }[])
            .map(({ id, localDateTime }) => ({ id, localDateTime: new Date(localDateTime) }))
            .toSorted((a, b) => a.localDateTime.getTime() - b.localDateTime.getTime()),
        ).slice(0, MAX_ON_THIS_DAY_ASSETS);
        return this.memoryRepository.create(
          {
            ownerId,
            type: MemoryType.OnThisDay,
            data: { year },
            memoryAt: target.set({ year }).toISO()!,
            showAt,
            hideAt,
          },
          new Set(kept.map(({ id }) => id)),
        );
      }),
    );
  }

  /**
   * Birthdays (FL-62): on the birthday of one of the owner's named people or pets, a memory of
   * their photos across the years. The birth date is the owner's explicit entry; the memory is
   * shown for that calendar day in every time zone and clients decide "today" from their own
   * local date. 29 February birthdays are kept on 28 February outside leap years. One per person
   * or pet per year, never for a hidden one or one the owner asked to see less of.
   */
  private async createBirthdayMemories(ownerId: string, target: DateTime, rules: MemoryShowLessRow[] = []) {
    const date = target.toFormat('yyyy-MM-dd');
    if (
      rules.some(
        ({ kind, value }) =>
          (kind === MemoryShowLessKind.Type && value === MemoryType.Birthday) ||
          (kind === MemoryShowLessKind.Date && value === target.toFormat('MM-dd')),
      )
    ) {
      return;
    }
    const monthDays = [target.toFormat('MM-dd')];
    if (target.month === 2 && target.day === 28 && !target.isInLeapYear) {
      monthDays.push('02-29');
    }
    const subjects = await this.memoryRepository.getBirthdaySubjects(ownerId, monthDays);
    for (const subject of subjects) {
      if (rules.some(({ kind, value }) => (kind === 'person' || kind === 'pet') && value === subject.id)) {
        continue;
      }
      if (birthdayOn(subject.birthDate, target.year) !== date) {
        continue;
      }
      if (await this.memoryRepository.hasSubjectMemory(ownerId, MemoryType.Birthday, subject.id, target.year)) {
        continue;
      }
      const candidates = suppressBursts(
        await this.memoryRepository.getSubjectAssets(ownerId, subject.subject, subject.id),
      );
      if (candidates.length < MIN_BIRTHDAY_ASSETS) {
        continue;
      }
      const kept = diversifyByYear(candidates, MAX_SUBJECT_MEMORY_ASSETS);
      const { showAt, hideAt } = calendarDayWindow(date);
      await this.memoryRepository.create(
        {
          ownerId,
          type: MemoryType.Birthday,
          data: {
            kind: 'birthday',
            year: target.year,
            date,
            subject: subject.subject,
            subjectId: subject.id,
            name: subject.name,
            age: birthdayAge(subject.birthDate, target.year),
          },
          memoryAt: DateTime.fromISO(date, { zone: 'utc' }).toISO()!,
          showAt: showAt.toISOString(),
          hideAt: hideAt.toISOString(),
        },
        new Set(kept.map(({ id }) => id)),
      );
    }
  }

  /**
   * Person and pet recaps (FL-62): a week into a new year, a memory of last year with each of the
   * owner's most photographed named people and pets (at most five, each with enough items), spread
   * across the months. One per person or pet per year.
   */
  private async createPersonRecaps(users: { id: string }[]) {
    const now = DateTime.utc();
    const year = now.minus({ days: YEAR_IN_REVIEW_DELAY_DAYS }).year - 1;
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.MemoriesState);
    if (state?.lastPersonRecapYear !== undefined && state.lastPersonRecapYear >= year) {
      return;
    }

    for (const { id: ownerId } of users) {
      try {
        await this.createPersonRecapsForOwner(ownerId, year);
      } catch (error) {
        this.logger.error(`Failed to create the ${year} person recaps for ${ownerId}: ${error}`);
      }
    }

    const latest = await this.systemMetadataRepository.get(SystemMetadataKey.MemoriesState);
    await this.systemMetadataRepository.set(SystemMetadataKey.MemoriesState, {
      ...(latest ?? { lastOnThisDayDate: now.toISO()! }),
      lastPersonRecapYear: year,
    });
  }

  private async createPersonRecapsForOwner(ownerId: string, year: number) {
    const rules = await this.memoryRepository.getShowLess(ownerId);
    if (rules.some(({ kind, value }) => kind === MemoryShowLessKind.Type && value === MemoryType.PersonRecap)) {
      return;
    }
    // localDateTime is the owner's wall clock stored as UTC, so the year is bounded in `utc`
    const window = {
      from: DateTime.utc(year, 1, 1).toJSDate(),
      to: DateTime.utc(year + 1, 1, 1).toJSDate(),
    };
    const subjects = await this.memoryRepository.getRecapSubjects(
      ownerId,
      window,
      MIN_PERSON_RECAP_ASSETS,
      MAX_PERSON_RECAPS + rules.length,
    );
    let created = 0;
    for (const subject of subjects) {
      if (created >= MAX_PERSON_RECAPS) {
        break;
      }
      if (rules.some(({ kind, value }) => (kind === 'person' || kind === 'pet') && value === subject.id)) {
        continue;
      }
      if (await this.memoryRepository.hasSubjectMemory(ownerId, MemoryType.PersonRecap, subject.id, year)) {
        continue;
      }
      const candidates = suppressBursts(
        await this.memoryRepository.getSubjectAssets(ownerId, subject.subject, subject.id, window),
      );
      if (candidates.length < MIN_PERSON_RECAP_ASSETS) {
        continue;
      }
      const kept = diversifyByMonth(candidates, MAX_SUBJECT_MEMORY_ASSETS);
      const memoryAt = DateTime.utc(year, 12, 31).endOf('day');
      await this.memoryRepository.create(
        {
          ownerId,
          type: MemoryType.PersonRecap,
          data: {
            kind: 'person_recap',
            year,
            subject: subject.subject,
            subjectId: subject.id,
            name: subject.name,
            assetCount: candidates.length,
          },
          memoryAt: memoryAt.toISO()!,
          showAt: memoryAt.toISO()!,
        },
        new Set(kept.map(({ id }) => id)),
      );
      created++;
    }
  }

  @OnJob({ name: JobName.MemoryCleanup, queue: QueueName.BackgroundTask })
  async onMemoriesCleanup() {
    try {
      // FL-194: the cleanup below takes highlight runs by cascade; their projects must go first
      await this.highlights.removeForExpiredMemories();
    } catch (error) {
      this.logger.warn(`Unable to remove highlights of expiring memories: ${error}`);
    }
    await this.memoryRepository.cleanup();
    try {
      await this.memoryRepository.cleanupCurations();
    } catch (error) {
      // a handoff in progress keeps the fork schema read-only; the next cleanup removes them
      this.logger.warn(`Unable to remove curation rows of deleted memories: ${error}`);
    }
    await this.reclaimExports();
  }

  // ---------------------------------------------------------------------------------------
  // Private highlight export (FL-62)
  //
  // The export is a durable run row plus one queued job that carries only the row id. The
  // row is the single source of truth, so the Activity page (FL-104) reads the same state
  // the worker writes, a reload loses nothing, and a cancel survives a worker restart.
  // Nothing here is a second job system: the work runs on the existing `BackgroundTask`
  // queue through `@OnJob`, exactly like the other memory jobs above.
  // ---------------------------------------------------------------------------------------

  async createExport(auth: AuthDto, id: string, dto: MemoryExportCreateDto): Promise<MemoryExportResponseDto> {
    await this.requireAccess({ auth, permission: Permission.MemoryRead, ids: [id] });

    const memory = await this.findOrFail(id, await this.readOptions(auth));
    const assets = 'assets' in memory ? memory.assets : [];
    if (assets.length === 0) {
      throw new BadRequestException('Memory has no assets to export');
    }
    if (assets.length > EXPORT_MAX_ASSETS) {
      throw new BadRequestException(`Memory has more than ${EXPORT_MAX_ASSETS} assets`);
    }

    // An export reads originals, which is a stronger right than viewing a memory, so the
    // download permission is rechecked here rather than assumed from memory ownership.
    const assetIds = assets.map(({ id }) => id);
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: assetIds });

    // One in-flight export per memory per owner. A second request returns the run already
    // running instead of writing the same archive twice.
    const format = dto.format ?? MemoryExportFormat.Archive;
    const inFlight = (
      await this.memoryRepository.searchExports(auth.user.id, {
        memoryId: id,
        status: [MemoryExportStatus.Pending, MemoryExportStatus.Running, MemoryExportStatus.Cancelling],
      })
    ).find((run) => run.format === format);
    if (inFlight) {
      return mapMemoryExport(await this.currentExport(inFlight));
    }

    if (format === MemoryExportFormat.Highlight) {
      // FL-194: the owner's own order and title, as the player shows them
      const curation = (await this.memoryRepository.getCurations(auth.user.id, [id])).get(id);
      const ordered = applyMemoryAssetOrder(assets, curation?.assetOrder);
      const run = await this.highlights.create(
        auth,
        { id, title: curation?.title || buildExportTitle(memory), assets: ordered },
        dto.highlight,
      );
      return mapMemoryExport(run);
    }

    const run = await this.memoryRepository.createExport({
      ownerId: auth.user.id,
      memoryId: id,
      format,
      status: MemoryExportStatus.Pending,
      title: buildExportTitle(memory),
      // snapshot: what the memory held when the owner asked, so later membership edits
      // cannot change an export that is already under way
      assetIds,
      assetCount: assetIds.length,
    });

    await this.jobRepository.queue({ name: JobName.MemoryExport, data: { id: run.id } });

    return mapMemoryExport(run);
  }

  async getExports(auth: AuthDto, memoryId?: string): Promise<MemoryExportResponseDto[]> {
    const runs = await this.withoutHiddenExports(
      auth,
      await this.memoryRepository.searchExports(auth.user.id, { memoryId }),
    );
    const current = [];
    for (const run of runs) {
      current.push(mapMemoryExport(await this.currentExport(run)));
    }
    return current;
  }

  async getExport(auth: AuthDto, id: string): Promise<MemoryExportResponseDto> {
    return mapMemoryExport(await this.currentExport(await this.findExportOrFail(auth, id)));
  }

  /** FL-194: save a finished highlight video to the owner's library. */
  async saveExportToLibrary(auth: AuthDto, id: string): Promise<MemoryExportResponseDto> {
    const run = (await this.findExportOrFail(auth, id)) as MemoryExport;
    if (run.format !== MemoryExportFormat.Highlight) {
      throw new BadRequestException('Only a highlight video can be saved to the library');
    }
    return mapMemoryExport(await this.highlights.saveToLibrary(auth, run));
  }

  /** A highlight run follows its Studio export; an archive run is its own authority. */
  private currentExport(run: { format: string }): Promise<MemoryExport> {
    return run.format === MemoryExportFormat.Highlight
      ? this.highlights.refresh(run as MemoryExport)
      : Promise.resolve(run as MemoryExport);
  }

  /**
   * Cancels a run. The request is recorded on the row; a run that has not started yet is
   * finished immediately, and a running one stops at its next asset. Cancelling an export
   * that already finished is a no-op that returns its final state, so a double click or a
   * stale Activity page cannot resurrect or corrupt a run.
   */
  async cancelExport(auth: AuthDto, id: string): Promise<MemoryExportResponseDto> {
    const run = await this.findExportOrFail(auth, id);
    if (run.format === MemoryExportFormat.Highlight) {
      return mapMemoryExport(await this.highlights.cancel(auth, run as MemoryExport));
    }
    if (isTerminalExportStatus(run.status as MemoryExportStatus)) {
      return mapMemoryExport(run);
    }

    const requested = await this.memoryRepository.requestExportCancel(id, auth.user.id);
    if (!requested) {
      return mapMemoryExport(await this.findExportOrFail(auth, id));
    }

    if (requested.status === MemoryExportStatus.Pending) {
      const finished = await this.memoryRepository.updateExport(id, {
        status: MemoryExportStatus.Cancelled,
        finishedAt: new Date(),
      });
      return mapMemoryExport(finished ?? requested);
    }

    const marked = await this.memoryRepository.updateExport(id, { status: MemoryExportStatus.Cancelling });
    return mapMemoryExport(marked ?? requested);
  }

  async deleteExport(auth: AuthDto, id: string): Promise<void> {
    const run = await this.findExportOrFail(auth, id);
    if (run.format === MemoryExportFormat.Highlight) {
      return this.highlights.remove(auth, run as MemoryExport);
    }
    if (!isTerminalExportStatus(run.status as MemoryExportStatus)) {
      await this.memoryRepository.requestExportCancel(id, auth.user.id);
    }

    const removed = await this.memoryRepository.deleteExport(id, auth.user.id);
    if (removed?.path) {
      await this.storageRepository.unlink(removed.path);
    }
  }

  /**
   * Streams a finished archive. The run is looked up by owner, so this is the only way the
   * file is reachable: the archive lives outside any served folder and its path is never
   * exposed. An expired run is treated as gone rather than served late.
   */
  async downloadExport(auth: AuthDto, id: string): Promise<ImmichReadStream> {
    const run = await this.findExportOrFail(auth, id);
    if (run.format === MemoryExportFormat.Highlight) {
      return this.highlights.download(auth, run as MemoryExport);
    }

    if (run.status !== MemoryExportStatus.Ready || !run.path) {
      throw new BadRequestException('Export is not ready');
    }
    if (run.expiresAt && run.expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException('Export has expired');
    }

    const stream = await this.storageRepository.createReadStream(run.path, 'application/zip');
    return {
      ...stream,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(run.title || 'memory')}.zip`,
    };
  }

  @OnJob({ name: JobName.MemoryExport, queue: QueueName.BackgroundTask })
  async handleMemoryExport({ id }: JobOf<JobName.MemoryExport>): Promise<JobStatus> {
    const claimed = await this.memoryRepository.claimExport(id);
    if (!claimed) {
      // either the row is gone with its memory or owner, or another delivery already owns
      // it; neither is a failure worth retrying
      this.logger.debug(`Memory export ${id} was not claimable`);
      return JobStatus.Skipped;
    }

    if (claimed.cancelRequestedAt) {
      await this.memoryRepository.updateExport(id, {
        status: MemoryExportStatus.Cancelled,
        finishedAt: new Date(),
      });
      return JobStatus.Skipped;
    }

    const assetIds = normalizeAssetIds(claimed.assetIds);
    const target = StorageCore.getNestedPath(StorageFolder.Exports, claimed.ownerId, `${claimed.id}.zip`);
    // written under a partial name and renamed only once the archive is complete, so an
    // interrupted worker can never leave a half-written file that looks downloadable
    const partial = `${target}.partial`;

    try {
      this.storageCore.ensureFolders(partial);

      // The worker has no `AuthDto`. Owner scoping is therefore enforced against the row's
      // own `ownerId`: an asset that is not the owner's, is trashed, or is no longer on the
      // timeline is skipped rather than written into the archive. The owner's Locked items stay
      // in (FL-195 follow-up): only a session that saw them could ask for this export, and the
      // export is hidden from every session that may not see them (`withoutHiddenExports`).
      const assets = await this.assetRepository.getByIds(assetIds);
      const byId = new Map(assets.map((asset) => [asset.id, asset]));

      const zip = this.storageRepository.createZipStream();
      const output = this.storageRepository.createWriteStream(partial);
      const finished = pipeline(zip.stream, output);
      // A throw inside the loop below skips `await finished`, which would leave this
      // promise rejected and unobserved. Attaching a handler now prevents an unhandled
      // rejection from taking the worker down; `await finished` still rethrows.
      void finished.catch(() => {});

      const names = new Map<string, number>();
      let processed = 0;
      let cancelled = false;
      let lastPoll = Date.now();

      for (const assetId of assetIds) {
        // Progress and cancellation share one throttled window: writing a row per asset
        // would be thousands of updates for a large memory, and the owner cannot perceive
        // a finer granularity than this anyway.
        if (Date.now() - lastPoll >= EXPORT_CANCEL_POLL_MS) {
          lastPoll = Date.now();
          await this.memoryRepository.updateExport(id, { processedAssets: processed });
          const current = await this.memoryRepository.getExportForJob(id);
          if (!current || current.cancelRequestedAt) {
            cancelled = true;
            break;
          }
        }

        const asset = byId.get(assetId);
        processed++;

        if (
          !asset ||
          asset.ownerId !== claimed.ownerId ||
          asset.deletedAt !== null ||
          asset.visibility !== AssetVisibility.Timeline
        ) {
          continue;
        }

        let filename = sanitize(asset.originalFileName) || 'unnamed';
        const seen = names.get(filename) ?? 0;
        names.set(filename, seen + 1);
        if (seen !== 0) {
          const parsed = parse(filename);
          filename = `${parsed.name}+${seen}${parsed.ext}`;
        }

        let realpath = asset.originalPath;
        try {
          realpath = await this.storageRepository.realpath(realpath);
        } catch {
          this.logger.warn('Unable to resolve realpath', { originalPath: asset.originalPath });
        }

        zip.addFile(realpath, filename);
      }

      await zip.finalize();
      await finished;

      // a cancel that lands while the last files are being written still discards the
      // archive rather than handing over a download the owner said to stop
      if (!cancelled) {
        const current = await this.memoryRepository.getExportForJob(id);
        // a row that vanished (its memory or its owner was deleted) is treated the same
        // way: throw the archive away rather than leave an unreachable file behind
        cancelled = !current || !!current.cancelRequestedAt;
      }

      if (cancelled) {
        await this.storageRepository.unlink(partial);
        await this.memoryRepository.updateExport(id, {
          status: MemoryExportStatus.Cancelled,
          finishedAt: new Date(),
          processedAssets: processed,
        });
        return JobStatus.Skipped;
      }

      await this.storageRepository.rename(partial, target);
      const { size } = await this.storageRepository.stat(target);

      await this.memoryRepository.updateExport(id, {
        status: MemoryExportStatus.Ready,
        path: target,
        sizeInBytes: size,
        processedAssets: processed,
        finishedAt: new Date(),
        expiresAt: DateTime.utc().plus({ hours: EXPORT_TTL_HOURS }).toJSDate(),
      });

      return JobStatus.Success;
    } catch (error) {
      this.logger.error(`Memory export ${id} failed: ${error}`);
      await this.storageRepository.unlink(partial);
      await this.memoryRepository.updateExport(id, {
        status: MemoryExportStatus.Failed,
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      });
      return JobStatus.Failed;
    }
  }

  /**
   * Reclaims expired archives and runs whose worker was lost — the recovery half of the
   * durable model. A run left `running` by a crashed worker is failed rather than left
   * spinning on the Activity page forever, and its partial file is removed.
   */
  private async reclaimExports() {
    const now = new Date();
    const staleBefore = DateTime.fromJSDate(now).minus({ minutes: EXPORT_STALE_MINUTES }).toJSDate();
    const runs = (await this.memoryRepository.getReclaimableExports(now, staleBefore)) ?? [];

    for (const run of runs) {
      await this.removeExportFiles(run);

      if (run.status === MemoryExportStatus.Ready) {
        // the archive is gone, so the run goes with it rather than lingering as a
        // download that would 404
        await this.memoryRepository.deleteExport(run.id, run.ownerId);
        continue;
      }

      await this.memoryRepository.updateExport(run.id, {
        status: run.cancelRequestedAt ? MemoryExportStatus.Cancelled : MemoryExportStatus.Failed,
        path: null,
        error: run.cancelRequestedAt ? null : 'Export was interrupted and did not resume',
        finishedAt: now,
      });
    }

    await this.removeOrphanedExportFiles();
  }

  private async removeExportFiles(run: { id: string; ownerId: string; path: string | null }) {
    if (run.path) {
      await this.storageRepository.unlink(run.path);
    }
    await this.storageRepository.unlink(
      StorageCore.getNestedPath(StorageFolder.Exports, run.ownerId, `${run.id}.zip.partial`),
    );
  }

  /**
   * A run row leaves with its memory (including the 30-day cleanup of unsaved memories) by
   * cascade, which cannot remove the archive on disk. Any archive or partial whose run no
   * longer exists is therefore removed here, so a deleted memory never leaves a private copy.
   */
  private async removeOrphanedExportFiles() {
    const files = new Map<string, string[]>();
    for await (const file of this.storageRepository.walkFiles(StorageCore.getBaseFolder(StorageFolder.Exports))) {
      const match = /^([\da-f-]{36})\.zip(\.partial)?$/i.exec(basename(file));
      if (!match) {
        continue;
      }
      const id = match[1].toLowerCase();
      files.set(id, [...(files.get(id) ?? []), file]);
    }
    if (files.size === 0) {
      return;
    }

    const existing = await this.memoryRepository.getExistingExportIds(files.keys().toArray());
    for (const [id, paths] of files) {
      if (existing.has(id)) {
        continue;
      }
      for (const path of paths) {
        await this.storageRepository.unlink(path);
      }
    }
  }

  private async findExportOrFail(auth: AuthDto, id: string) {
    const run = await findOrFail(() => this.memoryRepository.getExport(id, auth.user.id), 'MemoryExport');
    const [visible] = await this.withoutHiddenExports(auth, [run]);
    if (!visible) {
      throw new NotFoundException('MemoryExport not found');
    }
    return visible;
  }

  /**
   * FL-195 follow-up: an export made while the session was unlocked carries what its memory held,
   * Locked items included. Like its memory, it is hidden entirely — listing, progress, download and
   * every change — from a session that may not see one of those items, decided as the items stand
   * now, so a lock added after the export was made hides it too.
   */
  private async withoutHiddenExports<T extends { assetIds: unknown }>(auth: AuthDto, runs: T[]): Promise<T[]> {
    const ids = [...new Set(runs.flatMap((run) => normalizeAssetIds(run.assetIds)))];
    if (ids.length === 0) {
      return runs;
    }
    const hidden = await this.memoryRepository.getHiddenItemIds(ids, getHiddenContentQueryOptions(auth));
    return hidden.size === 0
      ? runs
      : runs.filter((run) => normalizeAssetIds(run.assetIds).every((id) => !hidden.has(id)));
  }

  async search(auth: AuthDto, dto: MemorySearchDto) {
    const curation = await this.curationFilter(auth.user.id, dto);
    if (!curation) {
      return [];
    }
    const options = { ...this.nsfwOptions(auth), ...curation };
    const memories = await this.memoryRepository.search(auth.user.id, dto, options);
    // FL-58: pet stories read as their pet is now, and leave when it is gone, hidden or suppressed
    const current = await this.withCurrentSubjects(auth, memories as Memory[]);
    const visible = current.filter((memory: Memory) => memory.assets && memory.assets.length > 0);
    const curations = await this.memoryRepository.getCurations(
      auth.user.id,
      visible.map(({ id }) => id),
    );
    return visible.map((memory: Memory) => mapMemory(memory, auth, curations.get(memory.id)));
  }

  async statistics(auth: AuthDto, dto: MemorySearchDto) {
    const curation = await this.curationFilter(auth.user.id, dto);
    if (!curation) {
      return { total: 0 };
    }
    const options = { ...this.nsfwOptions(auth), ...curation };
    const counted = await this.memoryRepository.statistics(auth.user.id, dto, options);
    // FL-58, FL-57: a pet story, birthday or recap whose pet or person is gone, hidden or suppressed
    // while locked does not exist here, as in search and get, so it is not counted either
    let excluded = 0;
    for (const type of SUBJECT_MEMORY_TYPES) {
      if (dto.type !== undefined && dto.type !== type) {
        continue;
      }
      const subjectDto = { ...dto, type, size: undefined, page: undefined };
      const named = (await this.memoryRepository.search(auth.user.id, subjectDto, options)) as Memory[];
      excluded += named.length - (await this.withCurrentSubjects(auth, named)).length;
    }
    return excluded > 0 ? { ...counted, total: Math.max(0, counted.total - excluded) } : counted;
  }

  /**
   * FL-62: what the owner's own curation leaves out of a search — the memories they hid (or, for
   * the hidden list, everything else) and their "show less" rules. A search for one memory by id
   * returns it whatever its state, so a hidden memory can still be opened and restored. Returns
   * null when nothing can match.
   */
  private async curationFilter(ownerId: string, dto: MemorySearchDto): Promise<MemoryCurationFilter | null> {
    const [hiddenIds, rules] = await Promise.all([
      this.memoryRepository.getHiddenMemoryIds(ownerId),
      this.memoryRepository.getShowLess(ownerId),
    ]);
    const valuesOf = (kind: MemoryShowLessKind) => rules.filter((rule) => rule.kind === kind).map(({ value }) => value);
    const people = valuesOf(MemoryShowLessKind.Person);
    const pets = valuesOf(MemoryShowLessKind.Pet);
    const filter: MemoryCurationFilter = {
      excludeTypes: valuesOf(MemoryShowLessKind.Type),
      excludeDates: valuesOf(MemoryShowLessKind.Date),
      excludeSubjectIds: [...people, ...pets],
      excludePersonIds: people,
      excludePetIds: pets,
    };
    if (dto.id) {
      // one memory by id, whatever its state, but never with the photos the owner asked to see less of
      return { excludePersonIds: people, excludePetIds: pets };
    }
    if (dto.isHidden) {
      return hiddenIds.length > 0 ? { ...filter, onlyIds: hiddenIds } : null;
    }
    return { ...filter, excludeIds: hiddenIds };
  }

  async get(auth: AuthDto, id: string): Promise<MemoryResponseDto> {
    await this.requireAccess({ auth, permission: Permission.MemoryRead, ids: [id] });
    const memory = await this.findOrFail(id, await this.readOptions(auth));
    const [current] = await this.withCurrentSubjects(auth, [memory as Memory]);
    if (!current) {
      throw new NotFoundException('Memory not found');
    }
    const curations = await this.memoryRepository.getCurations(auth.user.id, [id]);
    return mapMemory(current, auth, curations.get(id));
  }

  /** FL-62: the owner's "show less" rules, with the name of each person and pet they name. */
  async getShowLess(auth: AuthDto): Promise<MemoryShowLessResponseDto[]> {
    const rules = await this.memoryRepository.getShowLess(auth.user.id);
    const idsOf = (kind: MemoryShowLessKind) => rules.filter((rule) => rule.kind === kind).map(({ value }) => value);
    const [people, pets] = await Promise.all([
      this.memoryRepository.getOwnSubjectNames(auth.user.id, 'person', idsOf(MemoryShowLessKind.Person)),
      this.memoryRepository.getOwnSubjectNames(auth.user.id, 'pet', idsOf(MemoryShowLessKind.Pet)),
    ]);
    // A person or pet suppressed in a locked session answers as if it did not exist: no name.
    const nameOf = (kind: string, value: string) => {
      if (kind === MemoryShowLessKind.Person) {
        return isSuppressedWhileLocked(auth, 'person', value) ? undefined : people.get(value);
      }
      if (kind === MemoryShowLessKind.Pet) {
        return isSuppressedWhileLocked(auth, 'pet', value) ? undefined : pets.get(value);
      }
    };
    return rules.map(({ kind, value, createdAt }) => ({
      kind: kind as MemoryShowLessKind,
      value,
      name: nameOf(kind, value) ?? null,
      createdAt,
    }));
  }

  /**
   * FL-62: "show less" of one of the owner's people or pets, a calendar date or a kind of memory.
   * A person or pet must be the owner's own; memories already made for it disappear at once and
   * none are generated for it any more.
   */
  async addShowLess(auth: AuthDto, dto: MemoryShowLessDto): Promise<MemoryShowLessResponseDto[]> {
    const value = await this.validateShowLess(auth, dto);
    await this.memoryRepository.addShowLess(auth.user.id, dto.kind, value);
    return this.getShowLess(auth);
  }

  async removeShowLess(auth: AuthDto, dto: MemoryShowLessDto): Promise<MemoryShowLessResponseDto[]> {
    await this.memoryRepository.removeShowLess(auth.user.id, dto.kind, dto.value.trim());
    return this.getShowLess(auth);
  }

  private async validateShowLess(auth: AuthDto, { kind, value }: MemoryShowLessDto): Promise<string> {
    switch (kind) {
      case MemoryShowLessKind.Type: {
        if (!Object.values(MemoryType).includes(value as MemoryType)) {
          throw new BadRequestException('Unknown memory type');
        }
        return value;
      }
      case MemoryShowLessKind.Date: {
        const day = DateTime.fromFormat(`2024-${value}`, 'yyyy-MM-dd', { zone: 'utc' });
        if (!/^\d{2}-\d{2}$/.test(value) || !day.isValid) {
          throw new BadRequestException("A date must be written as 'MM-dd'");
        }
        return value;
      }
      case MemoryShowLessKind.Person:
      case MemoryShowLessKind.Pet: {
        const subject = kind === MemoryShowLessKind.Person ? 'person' : 'pet';
        const names = isSuppressedWhileLocked(auth, subject, value)
          ? new Map<string, string>()
          : await this.memoryRepository.getOwnSubjectNames(auth.user.id, subject, [value]);
        if (!names.has(value)) {
          throw new BadRequestException(subject === 'person' ? 'Not one of your people' : 'Not one of your pets');
        }
        return value;
      }
    }
  }

  async create(auth: AuthDto, dto: MemoryCreateDto) {
    // TODO validate type/data combination

    const assetIds = dto.assetIds || [];
    const allowedAssetIds = await this.checkAccess({
      auth,
      permission: Permission.AssetUpdate,
      ids: assetIds,
    });
    const memory = await this.memoryRepository.create(
      {
        ownerId: auth.user.id,
        type: dto.type,
        data: dto.data,
        isSaved: dto.isSaved,
        memoryAt: dto.memoryAt,
        showAt: dto.showAt,
        hideAt: dto.hideAt,
        seenAt: dto.seenAt,
      },
      allowedAssetIds,
    );

    // read back as this session sees it (FL-195 follow-up): the same rules as any other read
    return mapMemory((await this.findOrFail(memory.id, await this.readOptions(auth))) as Memory, auth);
  }

  async update(auth: AuthDto, id: string, dto: MemoryUpdateDto): Promise<MemoryResponseDto> {
    await this.requireAccess({ auth, permission: Permission.MemoryUpdate, ids: [id] });

    const options = await this.readOptions(auth);
    // FL-58: a pet story whose pet is gone, hidden or suppressed while locked answers 404, as get does
    const [visible] = await this.withCurrentSubjects(auth, [(await this.findOrFail(id, options)) as Memory]);
    if (!visible) {
      throw new NotFoundException('Memory not found');
    }

    // FL-62: hiding, the owner's own title and their item order are the owner's curation
    if (dto.isHidden !== undefined || dto.title !== undefined || dto.assetOrder !== undefined) {
      const assetOrder =
        dto.assetOrder === undefined
          ? undefined
          : [...(await this.memoryRepository.getAssetIds(id, [...new Set(dto.assetOrder)]))].toSorted(
              (a, b) => dto.assetOrder!.indexOf(a) - dto.assetOrder!.indexOf(b),
            );
      await this.memoryRepository.setCuration(auth.user.id, id, {
        hidden: dto.isHidden,
        title: dto.title,
        assetOrder,
      });
    }

    const update = omitBy(
      {
        isSaved: dto.isSaved,
        memoryAt: dto.memoryAt,
        seenAt: dto.seenAt,
      },
      isUndefined,
    );
    const memory =
      Object.keys(update).length > 0
        ? options
          ? await this.memoryRepository.update(id, update, options)
          : await this.memoryRepository.update(id, update)
        : await this.findOrFail(id, options);

    const curations = await this.memoryRepository.getCurations(auth.user.id, [id]);
    const [current] = await this.withCurrentSubjects(auth, [memory as Memory]);
    return mapMemory(current ?? (memory as Memory), auth, curations.get(id));
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.MemoryDelete, ids: [id] });
    // the export rows go with the memory by cascade; their private archives must go too
    const exports = await this.memoryRepository.searchExports(auth.user.id, { memoryId: id });
    for (const run of exports) {
      await this.removeExportFiles(run);
    }
    // FL-194: a highlight's render stops, and its project and private result go with the memory
    if (exports.some((run) => run.format === MemoryExportFormat.Highlight)) {
      await this.highlights.removeForMemory(auth.user.id, id);
    }
    await this.memoryRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.MemoryRead, ids: [id] });

    const repos = { access: this.accessRepository, bulk: this.memoryRepository };
    const results = await addAssets(auth, repos, {
      parentId: id,
      assetIds: dto.ids,
      permission: Permission.AssetUpdate,
    });

    const hasSuccess = results.some(({ success }) => success);
    if (hasSuccess) {
      await this.memoryRepository.update(id, { updatedAt: new Date() });
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.MemoryUpdate, ids: [id] });

    const repos = { access: this.accessRepository, bulk: this.memoryRepository };
    const results = await removeAssets(auth, repos, {
      parentId: id,
      assetIds: dto.ids,
      canAlwaysRemove: Permission.MemoryDelete,
    });

    const hasSuccess = results.some(({ success }) => success);
    if (hasSuccess) {
      await this.memoryRepository.update(id, { id, updatedAt: new Date() });
    }

    return results;
  }

  /**
   * FL-62: what a read of one memory may show this viewer: the hidden-content filter and, whatever the
   * memory's own state, never the photos of a person or pet the owner asked to see less of.
   */
  private async readOptions(auth: AuthDto): Promise<(HiddenContentQueryOptions & MemoryCurationFilter) | undefined> {
    const rules = await this.memoryRepository.getShowLess(auth.user.id);
    const valuesOf = (kind: MemoryShowLessKind) => rules.filter((rule) => rule.kind === kind).map(({ value }) => value);
    const people = valuesOf(MemoryShowLessKind.Person);
    const pets = valuesOf(MemoryShowLessKind.Pet);
    const nsfw = this.nsfwOptions(auth);
    if (!nsfw && people.length === 0 && pets.length === 0) {
      return undefined;
    }
    return { ...nsfw, excludePersonIds: people, excludePetIds: pets };
  }

  private findOrFail(id: string, options?: HiddenContentQueryOptions & MemoryCurationFilter) {
    return findOrFail(
      () => (options ? this.memoryRepository.get(id, options) : this.memoryRepository.get(id)),
      'Memory',
    );
  }

  /**
   * The session's privacy options, or undefined when there are none: hidden content while locked, or
   * (FL-195) the owner's own revealed locks while unlocked.
   */
  private nsfwOptions(auth: AuthDto) {
    const options = getHiddenContentQueryOptions(auth);
    return Object.keys(options).length > 0 ? options : undefined;
  }
}
