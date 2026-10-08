import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { writeFile } from 'node:fs/promises';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { STUDIO_ENGINE, STUDIO_ENVELOPE_SCHEMA_VERSION } from 'src/utils/studio-project.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { automock, getKyselyDB } from 'test/utils.js';

/**
 * FL-112 command axis for `readme.projects-storage.4` (project soft-delete, restore, empty-trash
 * and permanent delete), measured through the Studio project service on a real database: the
 * lifecycle the Studio project endpoints (`DELETE /studio/projects/:id`, `POST
 * /studio/projects/:id/trash/restore`, `POST /studio/projects/trash/empty`) call, one-to-one.
 *
 * Every case is measured, never assumed. For each lifecycle command the report records:
 *
 * - `normal`: the owner's request does what it says, on the shelf the library lists.
 * - `invalid`: a project that does not exist is refused, and nothing changes.
 * - `access`: a space reviewer is refused as not the owner, somebody else gets "not found", and
 *   nothing changes.
 * - `lease`: trashing takes the write lease from the editor holding it, whose next save is refused;
 *   after a restore nobody holds it and the owner takes it again explicitly.
 * - `revision`: after a restore, a save built on a revision older than the head is refused as
 *   `stale-revision` with the current revision; the head is what it was before the trash.
 * - `idempotence`: the same request twice answers the same and changes nothing the second time.
 * - `undo`: restoring undoes a trash exactly (shelf, name, space, head revision and document).
 *
 * Permanent deletion and emptying the trash cannot be undone by design (the trash is the
 * undoable step) and hold no lease or revision; those cases are `not-applicable` with that
 * reason, not claimed. STUDIO_LIFECYCLE_REPORT=<path> writes the report in the command matrix's
 * shape, for the evidence generator.
 */

type CaseResult = { case: string; result: 'passed' | 'failed' | 'not-applicable'; reason?: string };
const ROW = 'readme.projects-storage.4';
const report: { commands: Array<{ id: string; manifestIds: string[]; implementedBy: string; cases: CaseResult[] }> } = {
  commands: [],
};
const record = (id: string, cases: CaseResult[]) => {
  report.commands.push({ id, manifestIds: [ROW], implementedBy: 'server', cases });
};
const passed = (name: string): CaseResult => ({ case: name, result: 'passed' });
const notApplicable = (name: string, reason: string): CaseResult => ({ case: name, result: 'not-applicable', reason });

const envelope = (step: number) => ({
  schemaVersion: STUDIO_ENVELOPE_SCHEMA_VERSION,
  engine: STUDIO_ENGINE,
  engineRevision: 'lifecycle',
  graph: { tracks: [], step },
});

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
};
const conflictReason = (error: unknown) =>
  error instanceof ConflictException ? (error.getResponse() as { reason?: string; currentRevision?: number }) : null;

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => {
  if (process.env.STUDIO_LIFECYCLE_REPORT) {
    await writeFile(process.env.STUDIO_LIFECYCLE_REPORT, JSON.stringify(report, null, 2));
  }
  await database?.destroy();
});

/** An owner with a saved two-revision project shared with a space, a reviewer in that space, and a stranger. */
const setup = async () => {
  // Reading lifecycle responses resolves project resources against real source epochs.
  const { sut: resources, ctx } = newMediumService(StudioResourceService, {
    database,
    real: [AccessRepository, AssetRepository, CryptoRepository, IntegrityRepository],
    mock: [LoggingRepository],
  });
  const projects = new StudioProjectRepository(database);
  const sut = new StudioProjectService(
    ctx.getMock(LoggingRepository),
    projects,
    ctx.get(AccessRepository),
    resources,
    automock(WebsocketRepository, { args: [undefined, ctx.getMock(LoggingRepository)], strict: false }),
  );
  const { user: ownerUser } = await ctx.newUser();
  const { user: reviewerUser } = await ctx.newUser();
  const { user: strangerUser } = await ctx.newUser();
  const owner = factory.auth({ user: ownerUser });
  const reviewer = factory.auth({ user: reviewerUser });
  const stranger = factory.auth({ user: strangerUser });
  const { album: space } = await ctx.newAlbum({ ownerId: ownerUser.id, kind: AlbumKind.Space });
  await ctx.newAlbumUser({ albumId: space.id, userId: reviewerUser.id, role: AlbumUserRole.Viewer });

  const created = await sut.create(owner, {
    name: 'Lifecycle',
    clientId: 'tab-a',
    spaceId: space.id,
    envelope: envelope(1),
    requestKey: 'create',
  });
  await sut.save(owner, created.id, {
    clientId: 'tab-a',
    requestKey: 'save-2',
    expectedRevision: 1,
    envelope: envelope(2),
  } as never);
  const snapshot = async () => {
    const row = await projects.getById(created.id);
    const head = row && row.currentRevision > 0 ? await projects.getRevision(row.id, row.currentRevision) : undefined;
    return row
      ? {
          name: row.name,
          spaceId: row.spaceId,
          archivedAt: row.archivedAt,
          deletedAt: row.deletedAt,
          purgeAfter: row.purgeAfter,
          currentRevision: row.currentRevision,
          digest: head?.digest ?? null,
        }
      : null;
  };
  const shelf = async (name: 'active' | 'trash') =>
    (await sut.search(owner, { shelf: name } as never)).items.map((item: { id: string }) => item.id);
  return { sut, projects, owner, reviewer, stranger, id: created.id, snapshot, shelf };
};

describe('Studio project lifecycle (FL-112, readme.projects-storage.4)', () => {
  it('trash', async () => {
    const cases: CaseResult[] = [];
    const s = await setup();
    const before = await s.snapshot();

    // invalid
    const missing = await refusal(s.sut.remove(s.owner, '019a0000-0000-7000-8000-000000000000'));
    expect(missing).toBeInstanceOf(NotFoundException);
    expect(await s.snapshot()).toEqual(before);
    cases.push(passed('invalid'));

    // access
    expect(await refusal(s.sut.remove(s.reviewer, s.id))).toBeInstanceOf(ForbiddenException);
    expect(await refusal(s.sut.remove(s.stranger, s.id))).toBeInstanceOf(NotFoundException);
    expect(await s.snapshot()).toEqual(before);
    cases.push(passed('access'));

    // normal + lease: tab-a holds the lease while the owner trashes from elsewhere.
    expect((await s.projects.getById(s.id))?.leaseClientId).toBe('tab-a');
    await s.sut.remove(s.owner, s.id);
    const trashed = await s.snapshot();
    expect(trashed?.deletedAt).toBeInstanceOf(Date);
    expect(await s.shelf('trash')).toContain(s.id);
    expect(await s.shelf('active')).not.toContain(s.id);
    cases.push(passed('normal'));
    expect((await s.projects.getById(s.id))?.leaseClientId).toBeNull();
    const lateSave = await refusal(
      s.sut.save(s.owner, s.id, {
        clientId: 'tab-a',
        requestKey: 'late',
        expectedRevision: 2,
        envelope: envelope(3),
      } as never),
    );
    expect(conflictReason(lateSave)?.reason).toBe('project-trashed');
    const lateLease = await refusal(s.sut.acquireLease(s.owner, s.id, { clientId: 'tab-a' } as never));
    expect(conflictReason(lateLease)?.reason).toBe('project-trashed');
    expect(await s.snapshot()).toEqual(trashed);
    cases.push(passed('lease'));

    // idempotence: trashing again keeps the first deadline.
    await s.sut.remove(s.owner, s.id);
    expect(await s.snapshot()).toEqual(trashed);
    cases.push(passed('idempotence'));

    // undo + revision: restore brings back exactly what was trashed; a stale save is refused.
    await s.sut.restoreFromTrash(s.owner, s.id);
    expect(await s.snapshot()).toEqual({ ...before, deletedAt: null, purgeAfter: null });
    cases.push(passed('undo'));
    await s.sut.acquireLease(s.owner, s.id, { clientId: 'tab-b' } as never);
    const stale = await refusal(
      s.sut.save(s.owner, s.id, {
        clientId: 'tab-b',
        requestKey: 'stale',
        expectedRevision: 1,
        envelope: envelope(9),
      } as never),
    );
    expect(conflictReason(stale)).toMatchObject({ reason: 'stale-revision', currentRevision: before?.currentRevision });
    expect((await s.snapshot())?.currentRevision).toBe(before?.currentRevision);
    cases.push(passed('revision'));

    record('studio.project.trash', cases);
  });

  it('restore from the trash', async () => {
    const cases: CaseResult[] = [];
    const s = await setup();
    const before = await s.snapshot();
    await s.sut.remove(s.owner, s.id);
    const trashed = await s.snapshot();

    expect(await refusal(s.sut.restoreFromTrash(s.owner, '019a0000-0000-7000-8000-000000000000'))).toBeInstanceOf(
      NotFoundException,
    );
    expect(await s.snapshot()).toEqual(trashed);
    cases.push(passed('invalid'));

    // A trashed project is off the shelf for the reviewer too: not theirs to see, let alone restore.
    expect(await refusal(s.sut.restoreFromTrash(s.reviewer, s.id))).toBeInstanceOf(NotFoundException);
    expect(await refusal(s.sut.restoreFromTrash(s.stranger, s.id))).toBeInstanceOf(NotFoundException);
    expect(await s.snapshot()).toEqual(trashed);
    cases.push(passed('access'));

    const first = await s.sut.restoreFromTrash(s.owner, s.id);
    expect(await s.shelf('active')).toContain(s.id);
    expect(await s.shelf('trash')).not.toContain(s.id);
    cases.push(passed('normal'));

    const second = await s.sut.restoreFromTrash(s.owner, s.id);
    expect(second).toEqual(first);
    expect(await s.snapshot()).toEqual({ ...before, deletedAt: null, purgeAfter: null });
    cases.push(passed('idempotence'));

    // The lease was dropped by the trash; nobody holds it until the owner takes it explicitly.
    expect((await s.projects.getById(s.id))?.leaseClientId).toBeNull();
    await s.sut.acquireLease(s.owner, s.id, { clientId: 'tab-b' } as never);
    expect((await s.projects.getById(s.id))?.leaseClientId).toBe('tab-b');
    cases.push(passed('lease'));

    const stale = await refusal(
      s.sut.save(s.owner, s.id, {
        clientId: 'tab-b',
        requestKey: 'stale',
        expectedRevision: 1,
        envelope: envelope(9),
      } as never),
    );
    expect(conflictReason(stale)).toMatchObject({ reason: 'stale-revision', currentRevision: before?.currentRevision });
    cases.push(passed('revision'));

    // Trashing again undoes the restore.
    await s.sut.remove(s.owner, s.id);
    expect(await s.shelf('trash')).toContain(s.id);
    cases.push(passed('undo'));

    record('studio.project.restoreFromTrash', cases);
  });

  it('permanent delete and empty the trash', async () => {
    const permanent: CaseResult[] = [];
    const empty: CaseResult[] = [];
    const s = await setup();
    const other = await setup();

    // Permanent delete.
    expect(
      await refusal(s.sut.remove(s.owner, '019a0000-0000-7000-8000-000000000000', { permanent: true })),
    ).toBeInstanceOf(NotFoundException);
    permanent.push(passed('invalid'));
    expect(await refusal(s.sut.remove(s.reviewer, s.id, { permanent: true }))).toBeInstanceOf(ForbiddenException);
    expect(await refusal(s.sut.remove(s.stranger, s.id, { permanent: true }))).toBeInstanceOf(NotFoundException);
    expect(await s.snapshot()).not.toBeNull();
    permanent.push(passed('access'));
    await s.sut.remove(s.owner, s.id, { permanent: true });
    expect(await s.snapshot()).toBeNull();
    permanent.push(passed('normal'));
    expect(await refusal(s.sut.remove(s.owner, s.id, { permanent: true }))).toBeInstanceOf(NotFoundException);
    expect(await refusal(s.sut.restoreFromTrash(s.owner, s.id))).toBeInstanceOf(NotFoundException);
    permanent.push(passed('idempotence'));
    const gone = 'deleted for good by design; the trash is the step that can be undone';
    permanent.push(
      notApplicable('undo', gone),
      notApplicable('lease', 'a project that no longer exists has no lease to hold'),
      notApplicable('revision', 'a project that no longer exists has no revision to save against'),
    );
    record('studio.project.deletePermanently', permanent);

    // Empty the trash: only the caller's own trashed projects go.
    const t = await setup();
    await t.sut.remove(t.owner, t.id);
    await other.sut.remove(other.owner, other.id);
    const live = await t.sut.create(t.owner, { name: 'Still here', clientId: 'tab-c' } as never);
    expect(await refusal(t.sut.emptyTrash({ ...t.owner, sharedLink: {} } as never))).toBeInstanceOf(NotFoundException);
    expect(await t.snapshot()).not.toBeNull();
    const firstEmpty = await t.sut.emptyTrash(t.owner);
    expect(firstEmpty.count).toBe(1);
    expect(await t.snapshot()).toBeNull();
    expect(await t.projects.getById(live.id)).toBeDefined();
    expect(await other.snapshot()).not.toBeNull();
    empty.push(passed('normal'), passed('access'));
    expect((await t.sut.emptyTrash(t.owner)).count).toBe(0);
    empty.push(
      passed('idempotence'),
      notApplicable('invalid', "the request carries nothing to be invalid: it acts on the caller's own trash"),
      notApplicable('undo', gone),
      notApplicable('lease', 'trashed projects hold no lease'),
      notApplicable('revision', 'emptying the trash saves no revision'),
    );
    record('studio.project.emptyTrash', empty);
  });
});
