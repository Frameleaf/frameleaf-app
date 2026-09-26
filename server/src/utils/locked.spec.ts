import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, RawBuilder } from 'kysely';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';
import {
  effectiveVisibility,
  effectiveVisibilityOf,
  getLockedOwnerId,
  isDefaultVisible,
  isLocked,
  isLockedRow,
  isNotLocked,
  lockedForReason,
  notLockedOrOwnedBy,
  revealedLockScope,
  visibilityIn,
  visibilityIs,
} from 'src/utils/locked.js';
import { AuthFactory } from 'test/factories/auth.factory.js';

const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const compile = (expression: RawBuilder<unknown>) => {
  const { sql, parameters } = expression.compile(db);
  return { sql: sql.replaceAll(/\s+/g, ' ').trim(), parameters };
};

describe('the one Locked predicate (FL-34)', () => {
  it('reads Locked from the lock record, never from the stored visibility', () => {
    const { sql } = compile(isLocked('asset'));
    expect(sql).toBe('exists (select 1 from asset_lock where asset_lock."assetId" = "asset"."id")');
    expect(sql).not.toContain('visibility');
  });

  it('negates it for reads that must leave locked media out', () => {
    expect(compile(isNotLocked('stacked')).sql).toBe(
      'not exists (select 1 from asset_lock where asset_lock."assetId" = "stacked"."id")',
    );
  });

  it('lets only the given owner see their own locked media', () => {
    const scoped = compile(notLockedOrOwnedBy('owner-1', 'asset'));
    expect(scoped.sql).toContain('or "asset"."ownerId" = $1::uuid');
    expect(scoped.parameters).toEqual(['owner-1']);

    // without an owner, no locked media matches at all
    expect(compile(notLockedOrOwnedBy(undefined, 'asset')).sql).toBe(compile(isNotLocked('asset')).sql);
  });

  it('treats a requested visibility as the caller means it', () => {
    const locked = compile(visibilityIs(AssetVisibility.Locked, 'asset')).sql;
    expect(locked).toContain(`"asset"."visibility" != 'hidden'`);
    expect(locked).toContain('exists (select 1 from asset_lock');

    const timeline = compile(visibilityIs(AssetVisibility.Timeline, 'asset')).sql;
    expect(timeline).toContain(`"asset"."visibility" = 'timeline'`);
    expect(timeline).toContain('not exists (select 1 from asset_lock');

    expect(compile(visibilityIn([], 'asset')).sql).toBe('false');
  });

  it("reveals only the owner's sensitive marks and detections in an ordinary view, never the old folder", () => {
    const revealed = compile(revealedLockScope('owner-1', 'asset'));
    expect(revealed.sql).toContain(`asset_lock.reason in ('marked', 'detected')`);
    expect(revealed.sql).not.toContain('immich-locked-folder');
    expect(revealed.parameters).toEqual(['owner-1']);
    expect(compile(revealedLockScope(undefined, 'asset')).sql).toBe(compile(isNotLocked('asset')).sql);

    const timeline = compile(visibilityIs(AssetVisibility.Timeline, 'asset', 'owner-1')).sql;
    expect(timeline).toContain(`"asset"."visibility" = 'timeline'`);
    expect(timeline).toContain(`asset_lock.reason in ('marked', 'detected')`);
  });

  it('shows ordinary reads only unlocked Timeline and Archive media', () => {
    const { sql } = compile(isDefaultVisible('asset'));
    expect(sql).toContain(`"asset"."visibility" in ('archive', 'timeline')`);
    expect(sql).toContain('not exists (select 1 from asset_lock');
  });

  it('reports locked as the visibility of a locked asset, except a live photo video part', () => {
    const { sql } = compile(effectiveVisibility('asset'));
    expect(sql).toContain(`when "asset"."visibility" = 'hidden' then "asset"."visibility"`);
    expect(sql).toContain(`then 'locked'::asset_visibility_enum`);
  });

  it('filters by why an asset is locked', () => {
    expect(compile(lockedForReason([AssetLockReason.Detected], 'asset')).sql).toContain(
      `asset_lock.reason in ('detected')`,
    );
    expect(compile(lockedForReason([], 'asset')).sql).toBe('false');
  });

  it('decides a row read into memory from the lock it carries', () => {
    expect(isLockedRow({ isLocked: true, visibility: AssetVisibility.Timeline })).toBe(true);
    expect(isLockedRow({ visibility: AssetVisibility.Locked })).toBe(true);
    expect(isLockedRow({ isLocked: false, visibility: AssetVisibility.Timeline })).toBe(false);
    expect(effectiveVisibilityOf({ isLocked: true, visibility: AssetVisibility.Archive })).toBe(AssetVisibility.Locked);
    expect(effectiveVisibilityOf({ isLocked: true, visibility: AssetVisibility.Hidden })).toBe(AssetVisibility.Hidden);
    expect(effectiveVisibilityOf({ visibility: AssetVisibility.Archive })).toBe(AssetVisibility.Archive);
  });

  it('names the locked owner only for an elevated session that is not a shared link', () => {
    const auth = AuthFactory.create();
    expect(getLockedOwnerId(auth)).toBeUndefined();
    expect(getLockedOwnerId({ ...auth, session: { id: 'session-1', hasElevatedPermission: true } })).toBe(auth.user.id);
    expect(
      getLockedOwnerId({
        ...auth,
        session: { id: 'session-1', hasElevatedPermission: true },
        sharedLink: { id: 'link-1' } as never,
      }),
    ).toBeUndefined();
  });
});
