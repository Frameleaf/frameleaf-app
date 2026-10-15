import { CompiledQuery, Kysely, sql } from 'kysely';
import { SearchFacetField } from 'src/dtos/search.dto.js';
import { AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

/**
 * FL-139 (QA-103, server): performance budgets for a large library that do not depend on hardware.
 * A library of LIBRARY_SIZE items over five years is seeded and analysed; the queries a timeline
 * page makes are captured as run and planned with EXPLAIN. A plan shape is reproducible where a
 * timing is not: opening one month must never read the whole library.
 */
const LIBRARY_SIZE = 20_000;
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

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Plan Rows'?: number; Plans?: PlanNode[] };
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap((child) => nodes(child))];

/** The plan of the last query a call made, as run. */
const planOfLast = async (run: () => Promise<unknown>) => {
  captured.length = 0;
  await run();
  const query = captured.at(-1)!;
  const explained = await logged.executeQuery<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
    CompiledQuery.raw(`EXPLAIN (FORMAT JSON) ${query.sql}`, [...query.parameters]),
  );
  return nodes(explained.rows[0]['QUERY PLAN'][0].Plan);
};

describe('large-library query plans (FL-139)', () => {
  let ownerId: string;
  let repository: AssetRepository;
  let search: SearchRepository;

  beforeAll(async () => {
    const { ctx } = newMediumService(BaseService, {
      database: logged,
      real: [AssetRepository, SearchRepository],
      mock: [LoggingRepository],
    });
    const { user } = await ctx.newUser();
    ownerId = user.id;
    // someone else's library too, so a plan cannot win by reading everything
    const { user: other } = await ctx.newUser();
    const { asset: template } = await ctx.newAsset({ ownerId, visibility: AssetVisibility.Timeline });
    const { asset: otherTemplate } = await ctx.newAsset({ ownerId: other.id, visibility: AssetVisibility.Timeline });
    for (const [source, count] of [
      [template.id, LIBRARY_SIZE],
      [otherTemplate.id, LIBRARY_SIZE / 2],
    ] as const) {
      await sql`
        INSERT INTO asset
        SELECT (jsonb_populate_record(NULL::asset, to_jsonb(a) || jsonb_build_object(
          'id', gen_random_uuid(),
          'checksum', encode(sha256(convert_to(a.id::text || g::text, 'UTF8')), 'base64'),
          'originalPath', '/library/' || a.id::text || '/' || g || '.jpg',
          'originalFileName', 'IMG_' || lpad(g::text, 6, '0') || '.jpg',
          'deviceAssetId', a.id::text || g::text,
          'fileCreatedAt', (now() - (g * interval '130 minutes')),
          'localDateTime', (now() - (g * interval '130 minutes')),
          'fileModifiedAt', (now() - (g * interval '130 minutes'))
        ))).*
        FROM asset a, generate_series(1, ${count}) g
        WHERE a.id = ${source}::uuid
      `.execute(logged);
    }
    await sql`ANALYZE`.execute(logged);
    repository = ctx.get(AssetRepository);
    search = ctx.get(SearchRepository);
  }, 900_000);

  it('opens one month without reading the whole library', async () => {
    const auth = factory.auth({ user: { id: ownerId } });
    const month = new Date();
    month.setUTCDate(1);
    const timeBucket = month.toISOString().slice(0, 10);
    const plan = await planOfLast(() =>
      repository.getTimeBucket(timeBucket, { userIds: [ownerId], visibility: AssetVisibility.Timeline }, auth),
    );
    const scans = plan.filter((node) => node['Relation Name'] === 'asset').map((node) => node['Node Type']);
    expect(scans).not.toContain('Seq Scan');
  });

  const assetScans = (plan: PlanNode[]) =>
    plan.filter((node) => node['Relation Name'] === 'asset').map((node) => node['Node Type']);

  it('shows the first page of a library search without reading the whole library', async () => {
    const plan = await planOfLast(() =>
      search.searchMetadata({ page: 1, size: 100 }, { userIds: [ownerId], visibility: AssetVisibility.Timeline }),
    );
    expect(assetScans(plan)).not.toContain('Seq Scan');
  });

  // Postgres reads the whole table once a selection is a sizeable share of it, which is right; what
  // must hold is that a selection a person makes in a large library (1%) is found through the index
  it('loads a selection of 1% of the library by id without reading the whole library', async () => {
    const { rows } = await sql<{
      id: string;
    }>`SELECT id FROM asset WHERE "ownerId" = ${ownerId} LIMIT ${LIBRARY_SIZE / 100}`.execute(logged);
    const plan = await planOfLast(() => repository.getByIds(rows.map(({ id }) => id)));
    expect(assetScans(plan)).not.toContain('Seq Scan');
  });

  it('counts every facet of the library in one query, whatever its size', async () => {
    captured.length = 0;
    await search.searchFacets(
      { userIds: [ownerId], visibility: AssetVisibility.Timeline },
      {
        viewerId: ownerId,
        facets: Object.values(SearchFacetField),
        limit: 10,
        suppressedPersonIds: [],
        suppressedTagIds: [],
        covers: true,
      },
    );
    // not one query per facet value or per item: a fixed number however large the library
    expect(captured.length).toBe(FACET_QUERIES);
  });
});
