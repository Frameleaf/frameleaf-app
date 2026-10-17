import { ConflictException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyWorkflowRepository } from 'src/repositories/photography-workflow.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import type { PhotographyWorkflow } from 'src/services/photography-workflow.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => {
  await database?.destroy();
});

describe(PhotographyWorkflowRepository.name, () => {
  it("keeps the owner's revision for a client's write and moves it for the owner's edit (FL-423)", async () => {
    const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const repository = new PhotographyWorkflowRepository(database);
    const shootId = newUuid();
    const initial = { config: { title: 'Portrait' }, sessions: [], recipients: [] } as unknown as PhotographyWorkflow;

    // a workflow's first write always gets a revision
    const created = await repository.mutateKeepingRevision(shootId, user.id, album.id, null, initial, () => {});
    expect(created.row.revision).toEqual(expect.any(String));
    const edited = await repository.mutate(shootId, user.id, album.id, created.row.revision, initial, (value) => {
      value.config.title = 'Owner edit';
    });
    const held = edited.row.revision;
    expect(held).not.toBe(created.row.revision);

    // a client's sign-in is written, and the revision the owner holds stays current
    const session = {
      hash: 'a'.repeat(64),
      recipientId: newUuid(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const signedIn = await repository.mutateKeepingRevision(shootId, user.id, album.id, undefined, initial, (value) => {
      value.sessions.push(session);
    });
    expect(signedIn.row.revision).toBe(held);
    const stored = await repository.get(shootId);
    expect(stored).toMatchObject({ revision: held, value: { sessions: [session], config: { title: 'Owner edit' } } });

    // the owner's next save against what they hold succeeds and moves the revision; an older one is refused
    const saved = await repository.mutate(shootId, user.id, album.id, held, initial, (value) => {
      value.config.title = 'Saved after the client signed in';
    });
    expect(saved.row.revision).not.toBe(held);
    expect(saved.row.value.sessions).toEqual([session]);
    await expect(repository.mutate(shootId, user.id, album.id, held, initial, () => {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      repository.mutateKeepingRevision(shootId, user.id, album.id, held, initial, () => {}),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(repository.get(shootId)).resolves.toMatchObject({ revision: saved.row.revision });
  });
});
