import { Injectable } from '@nestjs/common';
import { type Kysely, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from 'src/schema/index.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { type DesktopClipSpace, parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { compatibleClipSpaces, equivalentDesktopModelKeys } from 'src/utils/desktop-model-equivalents.js';
import { canonicalJson } from 'src/utils/object.js';

export type DesktopClipIndexBinding = { revisionId: string; space: DesktopClipSpace };
export type DesktopClipReadGuard = {
  assertCurrent: () => Promise<void>;
  publish: <T>(write: () => Promise<T>) => Promise<T>;
};
const tables = ['smart_search', 'smart_search_description', 'video_moment_frame_embedding'];
const keys = (space: DesktopClipSpace) =>
  [`image:${space.visualModelKey}`, ...space.textModelKeys.map((key) => `text:${key}`)].sort();
/** Vectors this server's own AI made under the configured model name: every vector from before a desktop helped. */
const LEGACY = 'legacy';
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

  /**
   * Who may write vectors into an index admitted for `space`: this server's own AI (`legacy`), and every
   * released encoder of the same embedding space. A desktop runtime revision has model keys of its own, so
   * the same model appears as several spaces; the release shows they are one (`compatibleClipSpaces`).
   */
  private producers(space: DesktopClipSpace): string[] {
    return [LEGACY, ...new Set(compatibleClipSpaces(this.spaces, this.models, space).flatMap((item) => keys(item)))];
  }

  /** The model name the admitted index holds vectors of; undefined while no desktop has been granted smart search. */
  async modelName(): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('desktop_clip_index')
      .select('space')
      .where('scope', '=', 'clip')
      .executeTakeFirst();
    const key = row?.space?.visualModelKey;
    return key ? this.models.profiles.find((profile) => profile.modelKey === key)?.modelName : undefined;
  }

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
      const allowed = released && this.producers(released);
      if (
        !released ||
        identity(parsed) !== identity(released) ||
        gate ||
        producers.some((p) => p.scope !== 'clip' || !allowed!.includes(p.key))
      )
        throw new Error('invalid');
      await this.assertDimensions(target, released);
      return { revisionId: row.revisionId, space: parsed };
    } catch (error) {
      throw new Error('desktop_clip_index_invalid', { cause: error });
    }
  }

  /** Carry this snapshot across inference/cache reads; only DB adoption holds the admission lock. */
  async captureRead(): Promise<DesktopClipReadGuard> {
    const binding = structuredClone((await this.getActive()) ?? null);
    const validate = async (target: Kysely<DB> = this.db) => {
      const current = await this.getActive(target);
      if (
        binding
          ? !current || current.revisionId !== binding.revisionId || identity(current.space) !== identity(binding.space)
          : current !== undefined
      )
        throw new Error('desktop_clip_index_changed');
    };
    return {
      assertCurrent: () => validate(),
      publish: async <T>(write: () => Promise<T>): Promise<T> => {
        const adopt = async (tx: Kysely<DB>) => {
          const { rows } = await sql<{
            level: string;
          }>`SELECT current_setting('transaction_isolation') AS level`.execute(tx);
          if (rows[0]?.level !== 'read committed') throw new Error('desktop_clip_publication_isolation');
          await sql`SELECT pg_advisory_xact_lock_shared(912741, 1)`.execute(tx);
          await validate(tx);
          return write();
        };
        const tx = publicationTransaction.getStore();
        if (tx) return adopt(tx as unknown as Kysely<DB>);
        return this.db
          .transaction()
          .setIsolationLevel('read committed')
          .execute((tx) => publicationTransaction.run(tx, () => adopt(tx)));
      },
    };
  }

  space(spaceKey: string): DesktopClipSpace | undefined {
    return this.spaces.spaces.find((space) => space.spaceKey === spaceKey);
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
    // The same encoder under the other runtime revisions of this model: one embedding space, other keys.
    // This server's own AI is one build, and can only answer under the key of its own revision.
    const equivalents = equivalentDesktopModelKeys(profile.modelKey)
      .filter((key) => key !== profile.modelKey)
      .map((key) => this.models.profiles.find((item) => item.modelKey === key))
      .filter((item): item is NonNullable<typeof item> => !!item);
    return { binding, profile, equivalents };
  }

  /**
   * The key a vector made outside this network (Frameleaf Cloud) by the image encoder `modelKey` is stored
   * under. The features that compare photos only compare vectors of one producer key, and a release can add a
   * newer key for the same encoder, so a library keeps the key it already has: the admitted index's, or
   * before any desktop was granted, the one its vectors of this encoder already carry. Undefined when the
   * admitted index is another embedding space; that vector must not be stored.
   */
  async storageKey(modelKey: string): Promise<string | undefined> {
    const family = equivalentDesktopModelKeys(modelKey);
    const binding = await this.getActive();
    if (binding) {
      return family.includes(binding.space.visualModelKey) ? binding.space.visualModelKey : undefined;
    }
    const rows = await this.db
      .selectFrom('desktop_clip_producer')
      .select('key')
      .where(
        'key',
        'in',
        family.map((key) => `image:${key}`),
      )
      .execute();
    const used = new Set(rows.map((row) => row.key.slice('image:'.length)));
    return family.find((key) => key !== modelKey && used.has(key)) ?? modelKey;
  }

  /** Call only after selected NAS producer/config verification; this does not grant worker scope. */
  async admit(
    spaceKey: string,
    admission?: {
      transaction: Transaction<DB>;
      assertAuthority: () => Promise<void>;
    },
  ): Promise<DesktopClipIndexBinding> {
    const space = this.spaces.spaces.find((space) => space.spaceKey === spaceKey);
    if (!space) throw new Error('desktop_clip_space_unavailable');
    try {
      const admit = async (tx: Transaction<DB>) => {
        const {
          rows: [isolation],
        } = await sql<{ level: string }>`SELECT current_setting('transaction_isolation') level`.execute(tx);
        if (isolation.level !== 'read committed') throw new Error('desktop_clip_publication_isolation');
        await sql`SELECT pg_advisory_xact_lock(912741, 1)`.execute(tx);
        await admission?.assertAuthority();
        const current = await this.getActive(tx);
        const admitProducers = (allowed: string[]) =>
          tx
            .insertInto('desktop_clip_producer')
            .values(allowed.map((key) => ({ key, scope: 'clip' as const })))
            .onConflict((oc) => oc.column('key').doUpdateSet({ scope: 'clip' }))
            .execute();
        if (current) {
          // Another desktop runtime revision's keys for the same embedding space share the index.
          const allowed = this.producers(current.space);
          if (keys(space).some((key) => !allowed.includes(key))) throw new Error('desktop_clip_index_changed');
          // A later release can add encoders of this space; they become producers the first time one is granted.
          await admitProducers(allowed);
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
        await tx.insertInto('desktop_clip_index').values({ scope: 'clip', revisionId: randomUUID(), space }).execute();
        // The vectors already in the library stay: this server's AI made them under the configured model name
        // (a model change empties the library's vectors), which `assertAuthority` has just checked is this
        // space's model. Foreign keys serialize concurrent publications and refuse vectors of any other producer.
        const allowed = this.producers(space);
        await admitProducers(allowed);
        await tx.deleteFrom('desktop_clip_producer').where('key', 'not in', allowed).execute();
        await tx.deleteFrom('desktop_clip_index').where('scope', '=', 'unadmitted').execute();
        return (await this.getActive(tx))!;
      };
      return admission
        ? await admit(admission.transaction)
        : await this.db.transaction().setIsolationLevel('read committed').execute(admit);
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
    if (!active || active.revisionId !== binding.revisionId || identity(active.space) !== identity(binding.space))
      throw new Error('desktop_clip_index_changed');
  }
}
