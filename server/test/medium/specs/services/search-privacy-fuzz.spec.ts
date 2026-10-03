import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  LargeAssetSearchDto,
  MetadataSearchDto,
  RandomSearchDto,
  SearchFacetField,
  SearchFacetsDto,
  SearchHistogramDto,
  StatisticsSearchDto,
} from 'src/dtos/search.dto.js';
import {
  AlbumUserRole,
  AssetLockReason,
  AssetOrder,
  AssetType,
  AssetVisibility,
  Permission,
  SearchOrderField,
  SharedLinkType,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { SearchService } from 'src/services/search.service.js';
import { checkAccess } from 'src/utils/access.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

/**
 * FL-137 (QA-101): fuzz the structured search filter, cursor and replay surface against PostgreSQL.
 *
 * A seeded generator builds structured filters (nested `or`, every visibility including Locked,
 * ids of assets the viewer may not see, foreign albums, trashed dates, place and camera patterns)
 * and replays them, with forged and replayed cursors, as the owner (locked and unlocked), a
 * partner, an album member (both also unlocked) and a stranger. Invariants:
 *
 * - every asset id and every file name, city and camera make that belongs only to an asset the
 *   viewer cannot read (per the real access checks) is absent from every response body and every
 *   log line: results, facet labels and covers, histogram buckets;
 * - statistics, facets and histogram agree on the total, and paging with the cursor returns
 *   exactly that many distinct assets;
 * - anything refused is refused as a client error (validation, 400, 401, 403), never a crash.
 *
 * Replay a failure with FUZZ_SEED=<seed>.
 */
const SEED = Number(process.env.FUZZ_SEED ?? 0x5e_ed_01_37);
const ROUNDS = Number(process.env.FUZZ_ROUNDS ?? 40);

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d_2b_79_f5) >>> 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () =>
  newMediumService(SearchService, {
    database: db,
    real: [
      AccessRepository,
      AssetRepository,
      DatabaseRepository,
      SearchRepository,
      PartnerRepository,
      PersonRepository,
      TagRepository,
    ],
    mock: [LoggingRepository],
  });

type Context = ReturnType<typeof setup>['ctx'];

const ACTORS = [
  'owner',
  'ownerUnlocked',
  'partner',
  'partnerUnlocked',
  'member',
  'memberUnlocked',
  'link',
  'stranger',
] as const;
type Actor = (typeof ACTORS)[number];

/** A library whose every item carries its own file name, city and camera make as evidence. */
const library = async (ctx: Context) => {
  const tag = randomUUID().slice(0, 8);
  const { user: owner } = await ctx.newUser();
  const { user: partner } = await ctx.newUser();
  const { user: member } = await ctx.newUser();
  const { user: stranger } = await ctx.newUser();

  const assets: Array<{ id: string; ownerId: string; label: string; evidence: string[] }> = [];
  const add = async (
    ownerId: string,
    label: string,
    dto: Parameters<Context['newAsset']>[0] = {},
    lock?: AssetLockReason,
  ) => {
    const evidence = [`fz-${label}-${tag}.jpg`, `City-${label}-${tag}`, `Make-${label}-${tag}`];
    const { asset } = await ctx.newAsset({ ownerId, originalFileName: evidence[0], ...dto });
    await ctx.newExif({
      assetId: asset.id,
      city: evidence[1],
      country: `Country-${tag}`,
      make: evidence[2],
      rating: 3,
    });
    if (lock) {
      await db.insertInto('asset_lock').values({ assetId: asset.id, reason: lock, lockedBy: null }).execute();
    }
    assets.push({ id: asset.id, ownerId, label, evidence });
    return asset.id;
  };

  const ordinary = await add(owner.id, 'ordinary', { isFavorite: true });
  const archived = await add(owner.id, 'archived', { visibility: AssetVisibility.Archive });
  const trashed = await add(owner.id, 'trashed', { deletedAt: new Date() });
  const marked = await add(owner.id, 'marked', {}, AssetLockReason.Marked);
  const detected = await add(owner.id, 'detected', {}, AssetLockReason.Detected);
  const folder = await add(owner.id, 'folder', {}, AssetLockReason.ImmichLockedFolder);
  const motion = await add(owner.id, 'motion', { type: AssetType.Video, visibility: AssetVisibility.Hidden });
  const still = await add(owner.id, 'still', { livePhotoVideoId: motion });
  const lockedMotion = await add(owner.id, 'lockedmotion', {
    type: AssetType.Video,
    visibility: AssetVisibility.Hidden,
  });
  const lockedStill = await add(owner.id, 'lockedstill', { livePhotoVideoId: lockedMotion }, AssetLockReason.Marked);
  await add(partner.id, 'partnerown');
  await add(member.id, 'memberown');
  const memberTrashed = await add(member.id, 'membertrashed', { deletedAt: new Date() });
  await add(stranger.id, 'strangerown');

  const { album } = await ctx.newAlbum({ ownerId: owner.id });
  for (const assetId of [ordinary, archived, trashed, memberTrashed, marked, detected, folder, still, lockedStill]) {
    await ctx.newAlbumAsset({ albumId: album.id, assetId });
  }
  await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });
  const { album: foreignAlbum } = await ctx.newAlbum({ ownerId: stranger.id });
  await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id, inTimeline: true });

  const link = await ctx.get(SharedLinkRepository).create({
    key: randomBytes(16),
    id: factory.uuid(),
    userId: owner.id,
    albumId: album.id,
    allowUpload: false,
    allowDownload: true,
    type: SharedLinkType.Album,
  });

  const elevated = { session: { hasElevatedPermission: true } };
  const auths: Record<Actor, AuthDto> = {
    owner: factory.auth({ user: owner }),
    ownerUnlocked: factory.auth({ user: owner, ...elevated }),
    partner: factory.auth({ user: partner }),
    partnerUnlocked: factory.auth({ user: partner, ...elevated }),
    member: factory.auth({ user: member }),
    memberUnlocked: factory.auth({ user: member, ...elevated }),
    link: factory.auth({ user: owner, sharedLink: { id: link.id, allowDownload: true } }),
    stranger: factory.auth({ user: stranger }),
  };

  return { tag, assets, auths, albumIds: [album.id, foreignAlbum.id] };
};

type Library = Awaited<ReturnType<typeof library>>;

/** Everything in the library the actor must never see: ids and evidence of assets it cannot read. */
const forbiddenFor = async (access: AccessRepository, lib: Library, actor: Actor) => {
  const ids = new Set(lib.assets.map(({ id }) => id));
  const readable = await checkAccess(access, { auth: lib.auths[actor], permission: Permission.AssetRead, ids });
  return {
    readable,
    strings: lib.assets.filter(({ id }) => !readable.has(id)).flatMap(({ id, evidence }) => [id, ...evidence]),
  };
};

const VISIBILITIES = Object.values(AssetVisibility);
const ORDER_FIELDS = Object.values(SearchOrderField);

const generator = (random: () => number, lib: Library) => {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  const some = <T>(values: readonly T[]): T[] => {
    const chosen = values.filter(() => random() < 0.5);
    return chosen.length > 0 ? chosen : [pick(values)];
  };
  const ids = lib.assets.map(({ id }) => id);
  const labels = lib.assets.map(({ evidence }) => evidence);
  const dates = ['2000-01-01T00:00:00.000Z', new Date().toISOString(), '2100-01-01T00:00:00.000Z'];

  const conditions: Array<() => [string, unknown]> = [
    () => ['id', pick([{ eq: pick(ids) }, { ne: pick(ids) }])],
    () => [
      'visibility',
      pick([
        { eq: pick(VISIBILITIES) },
        { ne: pick(VISIBILITIES) },
        { in: some(VISIBILITIES) },
        { notIn: some(VISIBILITIES) },
      ]),
    ],
    () => ['type', pick([{ eq: AssetType.Image }, { ne: AssetType.Video }, { in: [AssetType.Video] }])],
    () => ['isFavorite', { eq: random() < 0.5 }],
    () => ['isMotion', { eq: random() < 0.5 }],
    () => ['hasAlbums', { eq: random() < 0.5 }],
    () => [
      'city',
      pick([{ eq: pick(labels)[1] }, { in: some(labels.map((label) => label[1])) }, { eq: null }, { ne: null }]),
    ],
    () => [
      'make',
      pick([{ like: pick(labels)[2].slice(5, 12) }, { startsWith: 'Make-' }, { notLike: 'Make-ordinary' }]),
    ],
    () => [
      'originalFileName',
      pick([{ startsWith: 'fz-' }, { endsWith: `${lib.tag}.jpg` }, { like: pick(labels)[0] }]),
    ],
    () => ['takenAt', pick([{ gte: pick(dates) }, { lt: pick(dates) }])],
    () => ['trashedAt', pick([{ eq: null }, { ne: null }, { gte: dates[0] }])],
    () => [
      'albumIds',
      pick([{ any: some(lib.albumIds) }, { all: [pick(lib.albumIds)] }, { none: [pick(lib.albumIds)] }]),
    ],
    () => ['rating', pick([{ gte: 1 }, { eq: null }, { in: [3] }])],
  ];

  const branch = () =>
    Object.fromEntries(Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(conditions)()));
  const filter = () =>
    random() < 0.3 ? { ...branch(), or: Array.from({ length: 1 + Math.floor(random() * 2) }, branch) } : branch();
  const orderBy = () => ({ field: pick(ORDER_FIELDS), direction: pick([AssetOrder.Asc, AssetOrder.Desc]) });
  /** A deprecated flat-field body, as older clients still send it. */
  const flat = (actor: Actor) => {
    const body: Record<string, unknown> = {};
    const fields: Array<() => void> = [
      () => (body.withDeleted = true),
      () => (body.trashedAfter = dates[0]),
      () => (body.isOffline = false),
      () => (body.visibility = pick([AssetVisibility.Timeline, AssetVisibility.Archive, AssetVisibility.Hidden])),
      () => (body.albumIds = [pick(lib.albumIds)]),
      () => (body.isFavorite = random() < 0.5),
      () => (body.city = pick(labels)[1]),
      () => (body.originalFileName = 'fz-'),
      () => (body.takenAfter = dates[0]),
    ];
    const count = 1 + Math.floor(random() * 4);
    for (let index = 0; index < count; index++) {
      pick(fields)();
    }
    // a shared link may only search inside an album
    if (actor === 'link') {
      body.albumIds = [lib.albumIds[0]];
    }
    return body;
  };

  return { filter, flat, orderBy, pick };
};

const CLIENT_ERRORS = [ZodError, BadRequestException, UnauthorizedException, ForbiddenException];

/** Runs a request as the API would: validate the body, then call the service. Client errors count as refusals. */
const attempt = async <T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (CLIENT_ERRORS.some((type) => error instanceof type)) {
      return { ok: false };
    }
    throw error;
  }
};

const expectNoEvidence = (payload: unknown, forbidden: string[], context: string) => {
  const body = JSON.stringify(payload);
  const leaked = forbidden.filter((value) => body.includes(value));
  expect(leaked, context).toEqual([]);
};

describe('search privacy fuzz (FL-137 QA-101)', () => {
  it(`never exposes unreadable evidence through structured filters, cursors or counts (seed ${SEED})`, async () => {
    const { sut, ctx } = setup();
    const lib = await library(ctx);
    const access = ctx.get(AccessRepository);
    const random = mulberry32(SEED);
    const gen = generator(random, lib);
    const forbidden = new Map<Actor, Awaited<ReturnType<typeof forbiddenFor>>>();
    for (const actor of ACTORS) {
      forbidden.set(actor, await forbiddenFor(access, lib, actor));
    }
    // The oracle itself: nobody but the unlocked owner reads a Locked item or its motion part.
    for (const actor of ACTORS) {
      const { readable } = forbidden.get(actor)!;
      const locked = lib.assets.filter(({ label }) =>
        ['marked', 'detected', 'folder', 'lockedstill', 'lockedmotion'].includes(label),
      );
      expect(locked.filter(({ id }) => readable.has(id)).length, actor).toBe(
        actor === 'ownerUnlocked' ? locked.length : 0,
      );
    }

    let answered = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const actor = gen.pick(ACTORS);
      const auth = lib.auths[actor];
      const { strings } = forbidden.get(actor)!;
      const filter = gen.filter();
      const context = `seed ${SEED} round ${round} ${actor} ${JSON.stringify(filter)}`;

      const statistics = await attempt(() => sut.searchStatistics(auth, StatisticsSearchDto.schema.parse({ filter })));
      if (!statistics.ok) {
        continue;
      }
      answered++;
      const facets = await sut.searchFacets(
        auth,
        SearchFacetsDto.schema.parse({
          filter,
          facets: Object.values(SearchFacetField),
          facetCovers: true,
          facetLimit: 50,
        }),
      );
      const histogram = await sut.searchHistogram(
        auth,
        SearchHistogramDto.schema.parse({ filter, granularity: 'day' }),
      );
      const randomItems = await sut.searchRandom(auth, RandomSearchDto.schema.parse({ filter, size: 50 }));
      expectNoEvidence(facets, strings, `facets ${context}`);
      expectNoEvidence(histogram, strings, `histogram ${context}`);
      expectNoEvidence(randomItems, strings, `random ${context}`);
      expect(facets.total, `facets total ${context}`).toBe(statistics.value.total);
      expect(histogram.total, `histogram total ${context}`).toBe(statistics.value.total);

      // Page through with the cursor, size 1 to 3, and replay each cursor once.
      const size = 1 + Math.floor(random() * 3);
      const orderBy = gen.orderBy();
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const body = MetadataSearchDto.schema.parse({ filter, orderBy, size, ...(cursor && { cursor }) });
        const response = await sut.searchMetadata(auth, body);
        expectNoEvidence(response, strings, `metadata page ${page} ${context}`);
        const replay = await sut.searchMetadata(auth, body);
        expect(
          replay.assets.items.map(({ id }) => id),
          `replay ${context}`,
        ).toEqual(response.assets.items.map(({ id }) => id));
        for (const { id } of response.assets.items) {
          expect(seen.has(id), `duplicate across pages ${context}`).toBe(false);
          seen.add(id);
        }
        cursor =
          response.assets.nextPage ??
          (response as { assets: { nextCursor?: string | null } }).assets.nextCursor ??
          undefined;
        if (!cursor) {
          break;
        }
      }
      expect(seen.size, `paged count ${context}`).toBe(statistics.value.total);

      // The deprecated flat fields reach the legacy builder: no invariant but "no unreadable evidence".
      const flat = gen.flat(actor);
      const flatContext = `seed ${SEED} round ${round} ${actor} flat ${JSON.stringify(flat)}`;
      const flatResults = [
        await attempt(() => sut.searchMetadata(auth, MetadataSearchDto.schema.parse({ ...flat, size: 50 }))),
        await attempt(() => sut.searchStatistics(auth, StatisticsSearchDto.schema.parse(flat))),
        await attempt(() => sut.searchRandom(auth, RandomSearchDto.schema.parse({ ...flat, size: 50 }))),
        await attempt(() => sut.searchLargeAssets(auth, LargeAssetSearchDto.schema.parse({ ...flat, size: 50 }))),
        await attempt(() => sut.searchFacets(auth, SearchFacetsDto.schema.parse({ ...flat, facetCovers: true }))),
      ];
      for (const result of flatResults) {
        if (result.ok) {
          expectNoEvidence(result.value, strings, flatContext);
        }
      }
    }
    // The generator must reach the database often enough for the invariants to mean something.
    expect(answered).toBeGreaterThan(ROUNDS / 4);

    const logger = ctx.getMock(LoggingRepository);
    const logged = JSON.stringify(
      (['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((level) => logger[level]?.mock?.calls ?? []),
    );
    for (const actor of ['partner', 'member', 'link', 'stranger'] as const) {
      expectNoEvidence(logged, forbidden.get(actor)!.strings, 'logs');
    }
  }, 300_000);

  it('still shows each viewer what they may see: the owner their archive and trash, a member the album archive', async () => {
    const { sut, ctx } = setup();
    const lib = await library(ctx);
    const id = (label: string) => lib.assets.find((asset) => asset.label === label)!.id;
    const ids = async (auth: AuthDto, body: object) =>
      (await sut.searchMetadata(auth, MetadataSearchDto.schema.parse({ ...body, size: 100 }))).assets.items.map(
        (asset) => asset.id,
      );

    await expect(ids(lib.auths.owner, { filter: { visibility: { eq: AssetVisibility.Archive } } })).resolves.toContain(
      id('archived'),
    );
    await expect(ids(lib.auths.owner, { filter: { trashedAt: { ne: null } } })).resolves.toContain(id('trashed'));
    await expect(ids(lib.auths.owner, { withDeleted: true, originalFileName: 'fz-' })).resolves.toContain(
      id('trashed'),
    );
    await expect(ids(lib.auths.member, { filter: { albumIds: { any: [lib.albumIds[0]] } } })).resolves.toContain(
      id('archived'),
    );
    await expect(ids(lib.auths.member, { albumIds: [lib.albumIds[0]] })).resolves.toContain(id('archived'));
    // A member keeps their own trashed album item; the album owner does not see it.
    await expect(
      ids(lib.auths.member, { filter: { albumIds: { any: [lib.albumIds[0]] }, trashedAt: { ne: null } } }),
    ).resolves.toEqual([id('membertrashed')]);
    await expect(
      ids(lib.auths.owner, { albumIds: [lib.albumIds[0]], withDeleted: true, originalFileName: 'fz-membertrashed' }),
    ).resolves.toEqual([]);
    // FL-326: a partner never finds the owner's own rows; they search their own copies.
    await expect(
      ids(lib.auths.partner, { filter: { originalFileName: { startsWith: 'fz-ordinary' } } }),
    ).resolves.toEqual([]);
  });

  it('refuses forged cursors as a client error and never pages past what the filter allows', async () => {
    const { sut, ctx } = setup();
    const lib = await library(ctx);
    const auth = lib.auths.partner;
    const { strings } = await forbiddenFor(ctx.get(AccessRepository), lib, 'partner');
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const forged = [
      'not-a-cursor',
      '%%%',
      encode({ offset: -1 }),
      encode({ offset: 1.5 }),
      encode({ offset: '1' }),
      encode({ offset: 0, ownerId: lib.assets[0].ownerId, visibility: 'locked' }),
      encode([0]),
      encode(null),
      Buffer.from('{"offset":').toString('base64url'),
    ];
    const filter = { originalFileName: { startsWith: 'fz-' } };
    for (const cursor of forged) {
      const result = await attempt(() => sut.searchMetadata(auth, MetadataSearchDto.schema.parse({ filter, cursor })));
      if (result.ok) {
        expectNoEvidence(result.value, strings, `cursor ${cursor}`);
      }
    }
    await expect(
      sut.searchMetadata(auth, MetadataSearchDto.schema.parse({ filter, cursor: encode({ offset: -1 }) })),
    ).rejects.toBeInstanceOf(BadRequestException);

    const far = await sut.searchMetadata(
      auth,
      MetadataSearchDto.schema.parse({ filter, cursor: encode({ offset: 1_000_000 }) }),
    );
    expect(far.assets.items).toEqual([]);
  });
});
