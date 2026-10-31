import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('finishes overlapping cycles and defers every constraint on each removed edge', () => {
  // Isolate synchronous schema reconstruction so a loop regression cannot block Vitest's timers.
  // This mirrors asset -> asset and asset -> stack -> asset, with two FKs on the latter edge.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { Column, ConstraintType, ForeignKeyConstraint, PrimaryColumn, Table, schemaFromCode }
          from '@frameleaf/sql-tools';
        class Asset {}
        class Stack {}
        class Owner {}
        for (const [target, name] of [[Asset, 'asset'], [Stack, 'stack'], [Owner, 'owner']]) {
          Table({ name })(target);
          PrimaryColumn({ type: 'uuid' })(target.prototype, 'id');
        }
        const foreignKey = (target, reference, column, name) => {
          Column({ type: 'uuid' })(target.prototype, column);
          ForeignKeyConstraint({ name, columns: [column], referenceTable: () => reference })(target);
        };
        foreignKey(Asset, Asset, 'livePhotoVideoId', 'asset_self');
        foreignKey(Asset, Stack, 'stackId', 'asset_stack');
        foreignKey(Asset, Stack, 'secondStackId', 'asset_second_stack');
        foreignKey(Stack, Asset, 'primaryAssetId', 'stack_asset');
        foreignKey(Asset, Owner, 'ownerId', 'asset_owner');
        const schema = schemaFromCode({ reset: true, overrides: false });
        process.stdout.write(JSON.stringify(schema.tables.flatMap(({ constraints }) =>
          constraints.filter(({ type }) => type === ConstraintType.FOREIGN_KEY)
            .map(({ name, deferred }) => ({ name, deferred: deferred === true }))
        )));
      `,
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    },
  );

  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.signal).toBeNull();
  expect(JSON.parse(result.stdout)).toEqual([
    { name: 'asset_self', deferred: true },
    { name: 'asset_stack', deferred: true },
    { name: 'asset_second_stack', deferred: true },
    { name: 'asset_owner', deferred: false },
    { name: 'stack_asset', deferred: false },
  ]);
}, 10_000);
