import { Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from 'src/schema/index.js';
import { type DesktopClipSpace, parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { canonicalJson } from 'src/utils/object.js';

export type DesktopClipIndexBinding = { revisionId: string; space: DesktopClipSpace };
const tables = [
  'smart_search',
  'smart_search_description',
  'asset_video_duplicate_frame',
  'video_moment_frame_embedding',
];
const keys = (space: DesktopClipSpace) =>
  [`image:${space.visualModelKey}`, ...space.textModelKeys.map((key) => `text:${key}`)].sort();
const identity = (space: DesktopClipSpace) =>
  canonicalJson({ ...space, textModelKeys: [...space.textModelKeys].sort() });

@Injectable()
export class DesktopClipIndexRepository {
  private models = parseDesktopModelCatalogue(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop/model-catalogue.json'), 'utf8')),
  );
  private spaces = parseDesktopClipSpaces(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop/model-spaces.json'), 'utf8')),
    this.models,
  );
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async getActive(target: Kysely<DB> = this.db): Promise<DesktopClipIndexBinding | undefined> {
    const row = await target
      .selectFrom('desktop_clip_index')
      .selectAll()
      .where('scope', '=', 'clip')
      .forShare()
      .executeTakeFirst();
    if (!row) return;
    try {
      const parsed = parseDesktopClipSpaces({ schemaVersion: 1, epoch: 1, spaces: [row.space] }, this.models).spaces[0];
      const released = this.spaces.spaces.find((space) => space.spaceKey === parsed.spaceKey);
      const producers = await target.selectFrom('desktop_clip_producer').selectAll().execute();
      const gate = await target
        .selectFrom('desktop_clip_index')
        .select('scope')
        .where('scope', '=', 'unadmitted')
        .executeTakeFirst();
      if (
        !released ||
        identity(parsed) !== identity(released) ||
        gate ||
        producers.some((p) => p.scope !== 'clip') ||
        canonicalJson(producers.map((p) => p.key).sort()) !== canonicalJson(keys(released))
      )
        throw new Error('invalid');
      await this.assertDimensions(target, released);
      return { revisionId: row.revisionId, space: parsed };
    } catch (error) {
      throw new Error('desktop_clip_index_invalid', { cause: error });
    }
  }

  async selectProfile(modelName: string, kind: 'image' | 'text', language?: string) {
    const binding = await this.getActive();
    if (!binding) return;
    const allowed = kind === 'image' ? [binding.space.visualModelKey] : binding.space.textModelKeys;
    const entries =
      kind === 'image'
        ? { clip: { visual: { modelName } } }
        : { clip: { textual: { modelName, options: language === undefined ? {} : { language } } } };
    const profile = this.models.profiles.find(
      (p) => allowed.includes(p.modelKey) && canonicalJson(p.spec.entries) === canonicalJson(entries),
    );
    if (!profile) throw new Error('desktop_clip_profile_unavailable');
    return { binding, profile };
  }

  /** Call only after selected NAS producer/config verification; this does not grant worker scope. */
  async admit(spaceKey: string): Promise<DesktopClipIndexBinding> {
    const space = this.spaces.spaces.find((space) => space.spaceKey === spaceKey);
    if (!space) throw new Error('desktop_clip_space_unavailable');
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (tx) => {
          await sql`SELECT pg_advisory_xact_lock(912741, 1)`.execute(tx);
          const current = await this.getActive(tx);
          if (current) {
            if (current.space.spaceKey !== spaceKey) throw new Error('desktop_clip_index_changed');
            return current;
          }
          const gate = await tx
            .selectFrom('desktop_clip_index')
            .select('scope')
            .where('scope', '=', 'unadmitted')
            .forUpdate()
            .executeTakeFirst();
          if (!gate) throw new Error('desktop_clip_index_invalid');
          await this.assertDimensions(tx, space);
          await tx
            .insertInto('desktop_clip_index')
            .values({ scope: 'clip', revisionId: randomUUID(), space })
            .execute();
          const allowed = keys(space);
          await tx
            .insertInto('desktop_clip_producer')
            .values(allowed.map((key) => ({ key, scope: 'clip' as const })))
            .onConflict((oc) => oc.column('key').doUpdateSet({ scope: 'clip' }))
            .execute();
          // Foreign keys serialize concurrent publications and refuse unknown or incompatible existing vectors.
          await tx.deleteFrom('desktop_clip_producer').where('key', 'not in', allowed).execute();
          await tx.deleteFrom('desktop_clip_index').where('scope', '=', 'unadmitted').execute();
          return (await this.getActive(tx))!;
        });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ['23503', '23001'].includes(String(error.code))
      )
        throw new Error('desktop_clip_index_incompatible', { cause: error });
      throw error;
    }
  }

  private async assertDimensions(target: Kysely<DB>, space: DesktopClipSpace): Promise<void> {
    const { rows } = await sql<{ name: string; dimensions: number }>`
      SELECT c.relname AS name, a.atttypmod AS dimensions
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = 'public' AND c.relname = ANY(${tables}::text[])
        AND a.attname = 'embedding' AND NOT a.attisdropped AND t.typname = 'vector'
    `.execute(target);
    const dimensions = this.models.profiles.find((p) => p.modelKey === space.visualModelKey)!.embeddingDimensions;
    if (rows.length !== tables.length || rows.some((row) => row.dimensions !== dimensions))
      throw new Error('desktop_clip_index_dimensions');
  }

  /** Supply the publication transaction to retain the index fence until claim adoption commits. */
  async assertCurrent(binding: DesktopClipIndexBinding, target: Kysely<DB> = this.db): Promise<void> {
    const active = await this.getActive(target);
    if (!active || active.revisionId !== binding.revisionId || active.space.spaceKey !== binding.space.spaceKey)
      throw new Error('desktop_clip_index_changed');
  }
}
