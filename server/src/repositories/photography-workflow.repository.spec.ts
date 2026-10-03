import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB } from 'src/schema/index.js';
import type { PhotographyWorkflow } from 'src/services/photography-workflow.service.js';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import * as migration from 'src/fork-schema/migrations/0000000000215-PhotographyWorkflow.js';
import { PhotographyWorkflowRepository } from 'src/repositories/photography-workflow.repository.js';

// Runnable isolated PostgreSQL check. Set PHOTOGRAPHY_TEST_PG_SOCKET to a disposable local test socket.
describe.runIf(!!process.env.PHOTOGRAPHY_TEST_PG_SOCKET)('photography persisted CAS and rollback', () => {
  let db: Kysely<DB>;
  const databaseName = `photography_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres({
    host: process.env.PHOTOGRAPHY_TEST_PG_SOCKET,
    port: 55_437,
    database: 'postgres',
    prepare: false,
  });
  const ownerId = randomUUID(),
    albumId = randomUUID(),
    shootId = randomUUID();
  const initial = {
    config: { title: 'Studio', mode: 'edited-delivery' },
    rounds: [],
    orders: [],
    captures: [],
    publication: null,
  } as unknown as PhotographyWorkflow;
  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    db = new Kysely<DB>({
      dialect: new PostgresJSDialect({
        postgres: postgres({
          host: process.env.PHOTOGRAPHY_TEST_PG_SOCKET,
          port: 55_437,
          database: databaseName,
          prepare: false,
        }),
      }),
    });
    await sql`CREATE SCHEMA immich_fork;
      CREATE TABLE immich_fork.state(id integer PRIMARY KEY,phase text); INSERT INTO immich_fork.state VALUES(1,'dual-write');
      CREATE TABLE immich_fork.migration_audit(name text,status text);
      CREATE TABLE public.migration_overrides(name text);
      CREATE TABLE public."user"(id uuid PRIMARY KEY,"deletedAt" timestamptz,status text);
      CREATE TABLE public.album(id uuid PRIMARY KEY,"deletedAt" timestamptz);
      CREATE TABLE public.album_user("albumId" uuid,"userId" uuid,role text);
    `.execute(db);
    await migration.up(db);
    await sql`INSERT INTO public."user" VALUES(${ownerId}::uuid,NULL,'active')`.execute(db);
    await sql`INSERT INTO public.album VALUES(${albumId}::uuid,NULL)`.execute(db);
    await sql`INSERT INTO public.album_user VALUES(${albumId}::uuid,${ownerId}::uuid,'owner')`.execute(db);
  });
  afterAll(async () => {
    await db?.destroy();
    await admin.unsafe(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });
  it('has no upstream foreign keys and records exact private catalog evidence', async () => {
    const evidence = await getCatalogEvidence(db, { includeForkLedger: false });
    const ours = (identity: string) => identity.startsWith('immich_fork.photography_');
    expect(evidence.constraints.filter((c) => ours(c.identity) && c.definition.includes('FOREIGN KEY'))).toEqual([]);
    await writeFile('/tmp/photography-workflow-catalog.json', JSON.stringify(evidence));
    await db.transaction().execute((tx) => migration.down(tx));
    await migration.up(db);
  });
  it('admits exactly one competing initial write, retains its value and rejects a foreign owner', async () => {
    const repository = new PhotographyWorkflowRepository(db);
    const writes = await Promise.allSettled(
      [1, 2].map((n) =>
        repository.mutate(shootId, ownerId, albumId, null, initial, (value) => {
          value.ordering = n === 1 ? 'manual' : 'chronological';
        }),
      ),
    );
    expect(writes.filter((w) => w.status === 'fulfilled')).toHaveLength(1);
    expect(writes.find((w) => w.status === 'rejected')).toMatchObject({ reason: expect.any(ConflictException) });
    const stored = await repository.get(shootId);
    expect(stored?.revision).toBeTruthy();
    expect(await repository.list(ownerId, [shootId])).toMatchObject([
      { shootId, title: 'Studio', submittedRounds: 0, unpaidOrders: 0, readyCount: 0, published: false },
    ]);
    expect(await repository.list(randomUUID(), [shootId])).toEqual([]);
    await expect(
      repository.mutate(shootId, randomUUID(), albumId, undefined, initial, () => {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(repository.mutate(shootId, ownerId, albumId, randomUUID(), initial, () => {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect((await repository.get(shootId))?.revision).toBe(stored?.revision);
  });
  it('persists site JSON through the server adapter and enforces competing revisions', async () => {
    const repository = new PhotographyWorkflowRepository(db);
    const site = {
      presentation: { layout: 'editorial', spacing: 'comfortable', font: 'editorial', palette: 'studio' },
      enabled: false,
      title: 'Studio',
      about: '',
      services: '',
      contact: '',
      portfolio: [],
    } as const;
    const writes = await Promise.allSettled(
      [1, 2].map(() => repository.saveSite(ownerId, null, { ...site, portfolio: [] })),
    );
    expect(writes.filter((write) => write.status === 'fulfilled')).toHaveLength(1);
    expect(writes.find((write) => write.status === 'rejected')).toMatchObject({
      reason: expect.any(ConflictException),
    });
    expect((await repository.site(ownerId))?.value).toEqual(site);
    await expect(repository.studioLive(randomUUID())).rejects.toThrow('Studio unavailable');
  });
  it('preserves legacy website values while sharing studio presets across owned galleries with both CAS bounds', async () => {
    const repository = new PhotographyWorkflowRepository(db);
    const existing = (await repository.site(ownerId))!;
    // Exact legacy flat record is wrapped without changing its website projection.
    await sql`UPDATE immich_fork.photography_studio_site SET value=${JSON.stringify(existing.value)}::text::jsonb WHERE "ownerId"=${ownerId}::uuid`.execute(
      db,
    );
    const presetId = randomUUID();
    const saved = await repository.mutateStudio(ownerId, existing.revision, (record) => {
      record.presets.push({ id: presetId, name: 'Reusable setup', config: initial.config });
    });
    expect((await repository.site(ownerId))?.value).toEqual(existing.value);
    expect((await repository.studioPresets(ownerId)).presets[0].id).toBe(presetId);
    const secondShootId = randomUUID(),
      secondAlbumId = randomUUID();
    await sql`INSERT INTO public.album VALUES(${secondAlbumId}::uuid,NULL)`.execute(db);
    await sql`INSERT INTO public.album_user VALUES(${secondAlbumId}::uuid,${ownerId}::uuid,'owner')`.execute(db);
    await repository.mutate(secondShootId, ownerId, secondAlbumId, null, initial, async (value, tx) => {
      value.config = (await repository.pinnedStudioPreset(tx, ownerId, saved.revision, presetId)).config;
    });
    expect((await repository.get(secondShootId))?.value.config).toEqual(initial.config);
    const first = await repository.get(shootId);
    await repository.mutate(shootId, ownerId, albumId, first!.revision, initial, async (value, tx) => {
      value.config = (await repository.pinnedStudioPreset(tx, ownerId, saved.revision, presetId)).config;
    });
    const snapshot = (await repository.get(secondShootId))!;
    await repository.mutateStudio(ownerId, saved.revision, (record) => {
      record.presets[0].config = { ...initial.config, title: 'Changed setup' };
    });
    expect((await repository.get(secondShootId))?.value).toEqual(snapshot.value);
    await expect(
      repository.mutate(secondShootId, ownerId, secondAlbumId, snapshot.revision, initial, async (_value, tx) => {
        await repository.pinnedStudioPreset(tx, ownerId, saved.revision, presetId);
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await repository.get(secondShootId))?.revision).toBe(snapshot.revision);
    await expect(repository.mutateStudio(ownerId, saved.revision, () => {})).rejects.toBeInstanceOf(ConflictException);
    const studio = await repository.studioPresets(ownerId);
    await repository.saveSite(ownerId, studio.revision, { ...existing.value!, title: 'Changed website' });
    expect((await repository.studioPresets(ownerId)).presets).toEqual(studio.presets);
    await expect(
      db.transaction().execute((tx) => repository.pinnedStudioPreset(tx, randomUUID(), saved.revision, presetId)),
    ).rejects.toThrow();
  });
  it('holds the reusable preset source snapshot through target commit', async () => {
    const repository = new PhotographyWorkflowRepository(db);
    const studio = await repository.studioPresets(ownerId);
    const { promise: acquired, resolve: entered } = Promise.withResolvers<void>();
    const { promise: continuation, resolve: release } = Promise.withResolvers<void>();
    const source = repository.mutate(shootId, ownerId, albumId, undefined, initial, async (value, tx) => {
      value.config = (await repository.pinnedStudioPreset(tx, ownerId, studio.revision!, studio.presets[0].id)).config;
      entered();
      await continuation;
    });
    await acquired;
    const update = repository.mutateStudio(ownerId, studio.revision, (record) => {
      record.presets[0].name = 'Updated';
    });
    release();
    await source;
    await update;
    expect((await repository.get(shootId))?.value.config.title).toBe('Changed setup');
  });
  it('holds rollback behind an in-flight writer and refuses nonempty history', async () => {
    const repository = new PhotographyWorkflowRepository(db);
    const { promise: writing, resolve: entered } = Promise.withResolvers<void>();
    const { promise: continueWrite, resolve: release } = Promise.withResolvers<void>();
    const writer = repository.mutate(shootId, ownerId, albumId, undefined, initial, async (value) => {
      entered();
      await continueWrite;
      value.ordering = 'manual';
    });
    await writing;
    const rollback = db.transaction().execute((tx) => migration.down(tx));
    release();
    await writer;
    await expect(rollback).rejects.toThrow('Photography history must be retained');
    expect((await repository.get(shootId))?.value.ordering).toBe('manual');
  });
});
