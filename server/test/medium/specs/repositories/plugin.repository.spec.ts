import { WorkflowTrigger } from '@immich/plugin-sdk';
import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PluginRepository } from 'src/repositories/plugin.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const setup = (database: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database,
    real: [PluginRepository],
    mock: [LoggingRepository],
  });
  return ctx.get(PluginRepository);
};

const seedPlugin = async (database: Kysely<DB>, allowedHostsColumn: boolean) => {
  const pluginId = randomUUID();
  const methodId = randomUUID();
  await sql`
    INSERT INTO public.plugin
      (id, enabled, name, version, title, description, author, "wasmBytes", templates, "sha256hash")
    VALUES (${pluginId}::uuid, true, ${`plugin-${pluginId}`}, '1.0.0', 'Plugin', 'Fixture', 'Immich',
      decode('00', 'hex'), '[]'::jsonb, sha256(decode('00', 'hex')))
  `.execute(database);
  const insertMethod = allowedHostsColumn
    ? sql`
      INSERT INTO public.plugin_method
        (id, "pluginId", name, title, description, types, "hostFunctions", "allowedHosts", "uiHints", schema)
      VALUES (${methodId}::uuid, ${pluginId}::uuid, 'webhook', 'Webhook', 'Fixture', ARRAY['AssetV1']::varchar[],
        true, ARRAY['hooks.example.test']::varchar[], ARRAY[]::varchar[], NULL)
    `
    : sql`
      INSERT INTO public.plugin_method
        (id, "pluginId", name, title, description, types, "hostFunctions", "uiHints", schema)
      VALUES (${methodId}::uuid, ${pluginId}::uuid, 'webhook', 'Webhook', 'Fixture', ARRAY['AssetV1']::varchar[],
        true, ARRAY[]::varchar[], NULL)
    `;
  await insertMethod.execute(database);
  return { methodId, pluginId };
};

describe(PluginRepository.name, () => {
  it.each([true, false])(
    'upgrades plugins with name-only uniqueness=%s without breaking workflow method references',
    async (uniqueName) => {
      const database = await getKyselyDB();
      try {
        if (!uniqueName) {
          await sql`ALTER TABLE public.plugin DROP CONSTRAINT plugin_name_uq`.execute(database);
        }
        const sut = setup(database);
        const { methodId, pluginId } = await seedPlugin(database, true);
        const plugin = await database
          .selectFrom('plugin')
          .selectAll()
          .where('id', '=', pluginId)
          .executeTakeFirstOrThrow();
        const method = await database
          .selectFrom('plugin_method')
          .selectAll()
          .where('id', '=', methodId)
          .executeTakeFirstOrThrow();
        const user = await mediumFactory.userWithClusterGroup(database);
        await database.insertInto('user').values(user).execute();
        const workflow = await database
          .insertInto('workflow')
          .values({ ownerId: user.id, trigger: WorkflowTrigger.AssetCreate })
          .returningAll()
          .executeTakeFirstOrThrow();
        const step = await database
          .insertInto('workflow_step')
          .values({ workflowId: workflow.id, pluginMethodId: methodId, enabled: true, order: 0 })
          .returningAll()
          .executeTakeFirstOrThrow();
        const { id: _pluginId, ...pluginDto } = plugin;
        const { id: _methodId, pluginId: _methodPluginId, ...methodDto } = method;
        const upgraded = await sut.upsert(
          {
            ...pluginDto,
            version: '2.0.1-fork.1',
            wasmBytes: Buffer.from('new-wasm'),
            sha256hash: Buffer.from('new-manifest'),
          },
          [{ ...methodDto, title: 'Upgraded webhook' }],
        );
        const repeated = await sut.upsert(
          {
            ...pluginDto,
            version: '2.0.1-fork.1',
            wasmBytes: Buffer.from('new-wasm'),
            sha256hash: Buffer.from('new-manifest'),
          },
          [{ ...methodDto, title: 'Upgraded webhook' }],
        );
        expect(repeated.id).toBe(upgraded.id);
        expect(repeated.methods[0]?.id).toBe(upgraded.methods[0]?.id);
        expect(
          await database.selectFrom('workflow_step').selectAll().where('id', '=', step.id).executeTakeFirst(),
        ).toEqual(step);
        if (uniqueName) {
          expect(upgraded.id).toBe(pluginId);
          expect(upgraded.methods[0]?.id).toBe(methodId);
          expect(
            await database
              .selectFrom('plugin')
              .select(['version', 'wasmBytes'])
              .where('id', '=', pluginId)
              .executeTakeFirst(),
          ).toEqual({ version: '2.0.1-fork.1', wasmBytes: Buffer.from('new-wasm') });
        } else {
          expect(upgraded.id).not.toBe(pluginId);
          expect(upgraded.methods[0]?.id).not.toBe(methodId);
          expect(
            await database.selectFrom('plugin').select('version').where('id', '=', pluginId).executeTakeFirst(),
          ).toEqual({ version: '1.0.0' });
        }
      } finally {
        await database.destroy();
      }
    },
  );

  it('returns an empty allowedHosts list from plugin and method searches on the legacy schema', async () => {
    const database = await getKyselyDB();
    // The migrated template already owns the column; recreate the legacy shape.
    await sql`ALTER TABLE public.plugin_method DROP COLUMN "allowedHosts"`.execute(database);
    const sut = setup(database);
    const { methodId, pluginId } = await seedPlugin(database, false);

    const plugins = await sut.search({ id: pluginId });
    const methods = await sut.searchMethods({ id: methodId });

    expect(plugins[0]?.methods[0]).toEqual(expect.objectContaining({ allowedHosts: [] }));
    expect(methods[0]).toEqual(expect.objectContaining({ allowedHosts: [] }));
  });

  it('returns official allowedHosts from plugin and method searches after the upstream migration', async () => {
    // The migrated template already reflects the upstream migration.
    const database = await getKyselyDB();
    const sut = setup(database);
    const { methodId, pluginId } = await seedPlugin(database, true);

    const plugins = await sut.search({ id: pluginId });
    const methods = await sut.searchMethods({ id: methodId });

    expect(plugins[0]?.methods[0]).toEqual(expect.objectContaining({ allowedHosts: ['hooks.example.test'] }));
    expect(methods[0]).toEqual(expect.objectContaining({ allowedHosts: ['hooks.example.test'] }));
  });
});
