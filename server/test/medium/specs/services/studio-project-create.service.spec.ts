import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { automock, getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => {
  await database?.destroy();
});

const setup = async () => {
  const { sut: resources, ctx } = newMediumService(StudioResourceService, {
    database,
    real: [AccessRepository, AssetRepository, CryptoRepository],
    mock: [LoggingRepository],
  });
  const repository = new StudioProjectRepository(database);
  const sut = new StudioProjectService(
    ctx.getMock(LoggingRepository),
    repository,
    ctx.get(AccessRepository),
    resources,
    automock(WebsocketRepository, { args: [undefined, ctx.getMock(LoggingRepository)], strict: false }),
  );
  const { user } = await ctx.newUser();
  const auth = factory.auth({ user });
  const dto = {
    name: 'Lake trip',
    clientId: 'tab-a',
    requestKey: 'first-save',
    envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'r', graph: { tracks: [] } },
  };
  const rows = () => database.selectFrom('studio_project').selectAll().where('ownerId', '=', user.id).execute();
  return { sut, repository, auth, dto, rows };
};

describe('Studio project creation persistence (FL-341)', () => {
  it('replays a response-loss retry with the same project and single initial revision', async () => {
    const s = await setup();
    const committed = await s.sut.create(s.auth, s.dto);
    const retried = await s.sut.create(s.auth, structuredClone(s.dto));
    expect(retried.id).toBe(committed.id);
    expect(retried).toEqual(committed);
    expect(await s.rows()).toHaveLength(1);
    expect((await s.repository.listRevisions(committed.id, { take: 10, skip: 0 })).total).toBe(1);
    expect(retried.lease.heldByYou).toBe(true);
  });

  it('decides concurrent identical retries in Postgres', async () => {
    const s = await setup();
    const [first, second] = await Promise.all([
      s.sut.create(s.auth, s.dto),
      s.sut.create(s.auth, structuredClone(s.dto)),
    ]);
    expect(first.id).toBe(second.id);
    expect(await s.rows()).toHaveLength(1);
    expect((await s.repository.listRevisions(first.id, { take: 10, skip: 0 })).total).toBe(1);
  });

  it.each(['envelope', 'name', 'clientId'] as const)('refuses the same key with a different %s', async (field) => {
    const s = await setup();
    const first = await s.sut.create(s.auth, s.dto);
    const changed = structuredClone(s.dto);
    if (field === 'envelope') changed.envelope.graph = { tracks: ['changed'] } as never;
    else changed[field] = 'different';
    await expect(s.sut.create(s.auth, changed)).rejects.toMatchObject({
      response: { reason: 'request-key-reused' },
    });
    expect((await s.rows()).map(({ id }) => id)).toEqual([first.id]);
    expect((await s.repository.listRevisions(first.id, { take: 10, skip: 0 })).total).toBe(1);
  });

  it('refuses one of two concurrent different payloads under the same key', async () => {
    const s = await setup();
    const results = await Promise.allSettled([
      s.sut.create(s.auth, s.dto),
      s.sut.create(s.auth, { ...s.dto, name: 'different' }),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected');
    expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(ConflictException);
    expect(await s.rows()).toHaveLength(1);
  });

  it('leaves no project or lease when the initial envelope is refused', async () => {
    const s = await setup();
    await expect(
      s.sut.create(s.auth, { ...s.dto, envelope: { ...s.dto.envelope, schemaVersion: 999 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await s.rows()).toEqual([]);
    // A refused attempt must not reserve the key against a corrected retry.
    expect((await s.sut.create(s.auth, s.dto)).revision).toBe(1);
  });

  it('rolls back the project and lease when inserting its initial revision fails', async () => {
    const s = await setup();
    await expect(
      s.repository.createWithRevision({
        ownerId: s.auth.user.id,
        name: s.dto.name,
        lease: { clientId: 'tab-a', leaseMs: 90_000 },
        revision: {
          authorId: newUuid(), // Foreign key failure after the project insert.
          envelope: s.dto.envelope,
          digest: 'digest',
          graphBytes: 12,
          summary: { counts: {}, total: 0 },
          requestKey: s.dto.requestKey,
        },
      }),
    ).rejects.toBeDefined();
    expect(await s.rows()).toEqual([]);
  });

  it('scopes creation keys to the owner and preserves memory-highlight and keyless callers', async () => {
    const s = await setup();
    const other = await setup();
    const first = await s.sut.create(s.auth, s.dto);
    const second = await other.sut.create(other.auth, s.dto);
    expect(second.id).not.toBe(first.id);
    const key = `memory-highlight:${newUuid()}`;
    const highlight = await s.sut.create(s.auth, { ...s.dto, clientId: key, requestKey: key });
    expect(highlight.revision).toBe(1);
    expect(highlight.lease.heldByYou).toBe(true);
    await s.sut.update(s.auth, highlight.id, { archived: true });
    expect((await s.repository.getById(highlight.id))?.leaseClientId).toBeNull();
    const keyless = { ...s.dto, requestKey: undefined };
    expect((await s.sut.create(s.auth, keyless)).id).not.toBe((await s.sut.create(s.auth, keyless)).id);
  });

  it('allows envelope-free creation, replay and a later leased first save', async () => {
    const s = await setup();
    const empty = { ...s.dto, envelope: undefined };
    const first = await s.sut.create(s.auth, empty);
    expect(first).toMatchObject({ revision: 0, envelope: null, lease: { heldByYou: true } });
    expect((await s.sut.create(s.auth, empty)).id).toBe(first.id);
    await s.sut.save(s.auth, first.id, { ...s.dto, expectedRevision: 0 });
    expect((await s.repository.getById(first.id))?.currentRevision).toBe(1);
    expect(await s.rows()).toHaveLength(1);
  });

  it('never takes over or renews another editor lease on replay', async () => {
    const s = await setup();
    const first = await s.sut.create(s.auth, s.dto);
    await s.sut.acquireLease(s.auth, first.id, { clientId: 'tab-b', takeover: true });
    const before = await s.repository.getById(first.id);
    const retry = await s.sut.create(s.auth, s.dto);
    expect(retry.id).toBe(first.id);
    expect(retry.lease).toMatchObject({ heldByYou: false, heldByAnother: true });
    expect(await s.repository.getById(first.id)).toEqual(before);
    await expect(
      s.sut.create(factory.auth({ user: s.auth.user, sharedLink: { id: newUuid() } }), s.dto),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
