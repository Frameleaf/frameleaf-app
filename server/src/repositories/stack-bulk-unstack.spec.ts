import { StackRepository } from 'src/repositories/stack.repository.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

it.each([false, true])('unstack selection protects the complete stack when elevation=%s', async (elevated) => {
  const members = [
    { id: 'open', stackId: 'open-stack', isLocked: false },
    { id: 'blocked', stackId: 'blocked-stack', isLocked: false },
    { id: 'unselected-locked-sibling', stackId: 'blocked-stack', isLocked: true },
    { id: 'unselected', stackId: 'unselected-stack', isLocked: false },
  ];
  const { db, queries } = scriptedKysely((query) =>
    query.sql.includes('from "stack"') && query.sql.startsWith('select')
      ? { rows: ['open-stack', 'blocked-stack', 'unselected-stack'].map((id) => ({ id })) }
      : query.sql.startsWith('select')
        ? { rows: members }
        : { rows: [] },
  );
  const repository = new StackRepository(db);
  vi.spyOn(
    repository as unknown as {
      authorityWrite: (
        owner: string,
        assets: string[],
        stacks: string[],
        write: (tx: unknown) => Promise<unknown>,
      ) => Promise<unknown>;
    },
    'authorityWrite',
  ).mockImplementation((_owner, _assets, _stacks, write) => write(db));
  const result = await repository.unstackSelection(
    authStub.user1,
    ['open-stack', 'blocked-stack', 'unselected-stack'],
    ['open', 'blocked', 'moved'],
    elevated,
  );
  expect(result).toEqual({
    deletedStackIds: elevated ? ['open-stack', 'blocked-stack'] : ['open-stack'],
    unstackedAssetIds: elevated ? ['open', 'blocked'] : ['open'],
    lockedAssetIds: elevated ? [] : ['blocked'],
  });
  const deletion = queries.find((query) => query.sql.startsWith('delete from "stack"'))!;
  expect(deletion.parameters).toEqual(elevated ? ['open-stack', 'blocked-stack'] : ['open-stack']);
  expect(queries[0].parameters).toContain(authStub.user1.user.id);
  expect(queries[1].sql).toContain('asset_lock');
  await db.destroy();
});
