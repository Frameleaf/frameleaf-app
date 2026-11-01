import { CompiledQuery, Kysely, sql } from 'kysely';
import { SearchFacetField } from 'src/dtos/search.dto.js';
import { AssetVisibility, TimeBucketDateType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { SCALE_ITEMS, scaleIt } from 'test/medium/scale.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

/**
 * FL-139 (QA-103, server): performance budgets for a large library that do not depend on hardware.
 * A library of LIBRARY_SIZE items over five years is seeded and analysed; the queries a timeline
 * page makes are captured as run and planned with EXPLAIN. A plan shape is reproducible where a
 * timing is not: opening one month must never read the whole library.
 */
const LIBRARY_SIZE = SCALE_ITEMS;
/** The queries one facets request makes. */
const FACET_QUERIES = 1;

let db: Kysely<DB>;
let logged: Kysely<DB>;
const captured: CompiledQuery[] = [];

beforeAll(async () => {
  db = await getActiveForkKyselyDB();
  const { rows } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
  const url = process.env.IMMICH_TEST_POSTGRES_URL!.replace(/\/[^/]+$/, () => `/${rows[0].name}`);
  logged = new Kysely<DB>({
    ...getKyselyConfig({ connectionType: 'url', url }),
    log: (event) => {
      if (event.level === 'query') {
        captured.push(event.query);
      }
    },
  });
}, 600_000);

afterAll(async () => {
  await logged?.destroy();
  await db?.destroy();
});

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'CTE Name'?: string;
  'Rows Removed by Filter'?: number;
  'Actual Rows': number;
  'Actual Loops': number;
  'Shared Hit Blocks': number;
  'Shared Read Blocks': number;
  'Temp Read Blocks': number;
  'Temp Written Blocks': number;
  Plans?: PlanNode[];
};
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap((child) => nodes(child))];

/** The plan of the last query a call made, as run. */
const planOfLast = async (run: () => Promise<unknown>) => {
  captured.length = 0;
  await run();
  const query = captured.findLast((query) => /^(with|select)\b/i.test(query.sql.trimStart()))!;
  const explained = await logged.executeQuery<{ 'QUERY PLAN': [{ Plan: PlanNode; 'Execution Time': number }] }>(
    CompiledQuery.raw(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${query.sql}`, [...query.parameters]),
  );
  const result = explained.rows[0]['QUERY PLAN'][0];
  process.stdout.write(
    `${JSON.stringify({
      librarySize: LIBRARY_SIZE,
      executionMs: result['Execution Time'],
      buffers: result.Plan['Shared Hit Blocks'] + result.Plan['Shared Read Blocks'],
      tempReadBlocks: result.Plan['Temp Read Blocks'],
      tempWrittenBlocks: result.Plan['Temp Written Blocks'],
    })}\n`,
  );
  return nodes(result.Plan);
};

describe('large-library query plans (FL-139)', () => {
  let ownerId: string;
  let repository: AssetRepository;
  let search: SearchRepository;

  beforeAll(
    async () => {
      const { ctx } = newMediumService(BaseService, {
        database: logged,
        real: [AssetRepository, SearchRepository],
        mock: [LoggingRepository],
      });
      const { user } = await ctx.newUser();
      ownerId = user.id;
      // someone else's library too, so a plan cannot win by reading everything
      const { user: other } = await ctx.newUser();
      // This is a read-query fixture; queue/ingest suites exercise upload triggers separately.
      await logged.transaction().execute(async (fixture) => {
        await sql`SET LOCAL session_replication_role = replica`.execute(fixture);
        for (const [owner, count] of [
          [ownerId, LIBRARY_SIZE],
          [other.id, LIBRARY_SIZE / 2],
        ] as const) {
          // Bound fixture statements as well as reads; keep five years of density at every scale.
          for (let start = 1; start <= count; start += 250_000) {
            const end = Math.min(count, start + 249_999);
            await sql`
          INSERT INTO asset (id, "ownerId", type, "originalPath", "originalFileName", checksum,
            "checksumAlgorithm", "fileCreatedAt", "fileModifiedAt", "localDateTime", width, height)
          SELECT md5(${owner} || ':' || g)::uuid, ${owner}::uuid, 'IMAGE', '/fixture/' || ${owner} || '/' || g || '.jpg',
            'IMG_' || lpad(g::text, 8, '0') || '.jpg', decode(md5(${owner} || ':' || g), 'hex'), 'sha1',
            '2025-01-01'::timestamptz - interval '1825 days' * (g::double precision / ${count}),
            '2025-01-01'::timestamptz - interval '1825 days' * (g::double precision / ${count}),
            '2025-01-01'::timestamptz - interval '1825 days' * (g::double precision / ${count}), 1920, 1080
          FROM generate_series(${start}::integer, ${end}::integer) g
        `.execute(fixture);
            // Timeline reads join EXIF: an asset-only fixture benchmarks an empty result.
            await sql`
          INSERT INTO asset_exif ("assetId", make, city, rating, "fileSizeInByte")
          SELECT md5(${owner} || ':' || g)::uuid, 'Fixture camera', 'Fixture city', 3, 4000000
          FROM generate_series(${start}::integer, ${end}::integer) g
        `.execute(fixture);
          }
        }
      });
      await sql`ANALYZE`.execute(logged);
      repository = ctx.get(AssetRepository);
      search = ctx.get(SearchRepository);
    },
    Math.max(900_000, LIBRARY_SIZE * 10),
  );

  scaleIt('returns seeded photos rather than benchmarking an empty metadata join (%i photos)', 1, async () => {
    const auth = factory.auth({ user: { id: ownerId } });
    const bucket = await repository.getTimeBucket(
      '2024-01-01',
      { userIds: [ownerId], visibility: AssetVisibility.Timeline },
      auth,
    );
    expect(JSON.parse(bucket.assets).id.length).toBeGreaterThan(0);
  });

  scaleIt('returns bounded page summaries whose counts cover the library exactly (%i photos)', 1, async () => {
    const auth = factory.auth({ user: { id: ownerId } });
    await planOfLast(async () => {
      const pages = await repository.getTimeBuckets(
        { userIds: [ownerId], visibility: AssetVisibility.Timeline },
        auth,
        { pageSize: 500 },
      );
      expect(pages.reduce((sum, page) => sum + page.count, 0)).toBe(LIBRARY_SIZE);
      expect(pages.every((page) => page.count > 0 && page.count <= 500)).toBe(true);
      expect(pages.length).toBeLessThanOrEqual(Math.ceil(LIBRARY_SIZE / 500) + 61);
      expect(new Set(pages.map((page) => page.firstAssetId)).size).toBe(pages.length);
    });
  });

  scaleIt('opens one month without reading the whole library (%i photos)', 1, async () => {
    const auth = factory.auth({ user: { id: ownerId } });
    const timeBucket = '2024-01-01';
    const plan = await planOfLast(() =>
      repository.getTimeBucket(timeBucket, { userIds: [ownerId], visibility: AssetVisibility.Timeline }, auth),
    );
    const scans = plan.filter((node) => node['Relation Name'] === 'asset').map((node) => node['Node Type']);
    expect(scans).not.toContain('Seq Scan');
  });

  scaleIt('bounds a dense date-added month and seeks without skipping earlier pages (%i photos)', 1, async () => {
    const auth = factory.auth({ user: { id: ownerId } });
    const options = { userIds: [ownerId], visibility: AssetVisibility.Timeline, dateType: TimeBucketDateType.Added };
    const buckets = await repository.getTimeBuckets(options, auth);
    expect(buckets).toHaveLength(1);
    expect(Number(buckets[0].count)).toBe(LIBRARY_SIZE);
    const first = JSON.parse(
      (await repository.getTimeBucket(buckets[0].timeBucket, options, auth, { take: 500 })).assets,
    );
    expect(first.id).toHaveLength(500);
    expect(new Set(first.ownerId)).toEqual(new Set([ownerId]));
    const plan = await planOfLast(async () => {
      const second = JSON.parse(
        (
          await repository.getTimeBucket(buckets[0].timeBucket, options, auth, {
            take: 500,
            after: first.endCursor,
          })
        ).assets,
      );
      expect(second.id).toHaveLength(500);
      expect(second.id.some((id: string) => first.id.includes(id))).toBe(false);
    });
    const assetRows = plan
      .filter((node) => node['Relation Name'] === 'asset')
      .reduce((rows, node) => rows + node['Actual Rows'] * node['Actual Loops'], 0);
    expect(assetRows).toBeLessThanOrEqual(2000);
  });

  scaleIt('covers every photo in calendar highlights (%i photos)', 1, async () => {
    const auth = factory.auth({ user: { id: ownerId } });
    const plan = await planOfLast(async () => {
      const highlights = await repository.getTimelineHighlights(
        { userIds: [ownerId], visibility: AssetVisibility.Timeline },
        auth,
        { grouping: 'month', highlightCount: 4, withPlaces: true },
      );
      expect(highlights.reduce((total, bucket) => total + bucket.count, 0)).toBe(LIBRARY_SIZE);
      expect(highlights.every((bucket) => bucket.highlightAssetIds.length <= 4)).toBe(true);
    });
    const examined = plan
      .filter((node) => node['CTE Name'] === 'asset')
      .reduce(
        (total, node) => total + (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'],
        0,
      );
    expect(examined).toBeLessThanOrEqual(LIBRARY_SIZE * 3);
  });

  scaleIt('returns a deep ordered page and continues without duplicates (%i photos)', 1, async () => {
    const auth = factory.auth({ user: { id: ownerId } });
    const options = { userIds: [ownerId], visibility: AssetVisibility.Timeline };
    for (const sort of ['filename', 'rating', 'quality'] as const) {
      let page: { id: string[]; endCursor: string };
      await planOfLast(async () => {
        page = JSON.parse(
          (
            await repository.getTimelineOrdered(options, auth, {
              sort,
              skip: LIBRARY_SIZE - 1000,
              take: 500,
            })
          ).assets,
        );
        expect(page.id).toHaveLength(500);
      });
      await planOfLast(async () => {
        expect(
          await repository.getTimeBuckets(options, auth, {
            pageSize: 500,
            locateAssetId: page!.id[0],
            sort,
          }),
        ).toEqual([{ timeBucket: '1970-01-01', page: (LIBRARY_SIZE - 1000) / 500, count: 500 }]);
      });
      const [key, date, id] = JSON.parse(page!.endCursor);
      const next = JSON.parse(
        (
          await repository.getTimelineOrdered(options, auth, {
            sort,
            skip: 0,
            take: 500,
            cursor: { key, date, id },
          })
        ).assets,
      );
      expect(next.id).toHaveLength(500);
      expect(next.id.some((id: string) => page!.id.includes(id))).toBe(false);
    }
  });

  const assetScans = (plan: PlanNode[]) =>
    plan.filter((node) => node['Relation Name'] === 'asset').map((node) => node['Node Type']);

  scaleIt('shows the first page of a library search without reading the whole library (%i photos)', 1, async () => {
    const plan = await planOfLast(() =>
      search.searchMetadata({ page: 1, size: 100 }, { userIds: [ownerId], visibility: AssetVisibility.Timeline }),
    );
    expect(assetScans(plan)).not.toContain('Seq Scan');
  });

  // Postgres reads the whole table once a selection is a sizeable share of it, which is right; what
  // must hold is that a selection a person makes in a large library (1%) is found through the index
  scaleIt('loads a selection of 1% of the library by id without reading the whole library (%i photos)', 1, async () => {
    const { rows } = await sql<{
      id: string;
    }>`SELECT id FROM asset WHERE "ownerId" = ${ownerId} LIMIT ${LIBRARY_SIZE / 100}`.execute(logged);
    const plan = await planOfLast(() => repository.getByIds(rows.map(({ id }) => id)));
    expect(assetScans(plan)).not.toContain('Seq Scan');
  });

  scaleIt('counts every facet of the library in one query, whatever its size (%i photos)', 1, async () => {
    captured.length = 0;
    await search.searchFacets(
      { userIds: [ownerId], visibility: AssetVisibility.Timeline },
      {
        viewerId: ownerId,
        facets: Object.values(SearchFacetField),
        limit: 10,
        suppressedPersonIds: [],
        suppressedTagIds: [],
        suppressedPetIds: [],
        covers: true,
      },
    );
    // not one query per facet value or per item: a fixed number however large the library
    expect(captured.length).toBe(FACET_QUERIES);
  });
});
