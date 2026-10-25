import { Injectable } from '@nestjs/common';
import { Kysely, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { SourceResourceReadRepository } from 'src/repositories/source-resource-read.repository.js';
import type { DB } from 'src/schema/index.js';
import { removeSourceCacheReaderMarker, sourceCacheClosedMatches } from 'src/utils/source-cache-closed.js';
import { sourceCacheDiskIsAccounted } from 'src/utils/source-cache-disk.js';
import { sourceReadHasInterest } from 'src/utils/source-read-interest.js';

type Original = NonNullable<Awaited<ReturnType<SourceResourceReadRepository['beginDelivery']>>>;
export type SourceCacheReader = { readerId: string; ownerId: string } & (
  { kind: 'http' } | { kind: 'job'; jobId: string; attemptToken: string }
);
const MAX_CACHE_ENTRIES = 4096;
const MAX_CACHE_READERS = 64;
const readerStopKey = (cacheId: string) => `frameleaf-source-reader-stopped:${cacheId}`;
const leaseId = (value: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const digest = (value: string) => /^[a-f0-9]{64}$/u.test(value);

/** Storage ownership only. Callers authenticate the source and confirm live provider permission before serving. */
@Injectable()
export class SourceResourceCacheRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async reserve(
    tx: Transaction<DB>,
    original: Original,
    capacity: number,
    writer: { id: string; ownerId: string },
    snapshot: readonly { id: string; bytes: number }[],
  ) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      !Number.isSafeInteger(original.bytes) ||
      original.bytes < 1 ||
      original.bytes > capacity ||
      [original.version, original.resourceKey, original.scopeFingerprint, original.sha256].some(
        (value) => !digest(value),
      )
    )
      return;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('frameleaf-source-cache-capacity-v1',0))`.execute(tx);
    const entries = await tx
      .selectFrom('source_resource_cache')
      .select(['id', 'bytes'])
      .limit(MAX_CACHE_ENTRIES)
      .execute();
    const bytes = entries.reduce((sum, entry) => sum + BigInt(entry.bytes), 0n);
    if (entries.length >= MAX_CACHE_ENTRIES || bytes + BigInt(original.bytes) > BigInt(capacity)) return;
    const observed = new Map(snapshot.map((entry) => [entry.id, entry.bytes]));
    if (entries.length !== snapshot.length || entries.some((entry) => observed.get(entry.id) !== entry.bytes))
      return 'snapshot-changed' as const;
    return tx
      .insertInto('source_resource_cache')
      .values({
        readId: original.id,
        claimFence: original.claimFence,
        assetId: original.assetId,
        resourceId: original.resourceId,
        sourceId: original.sourceId,
        ownerId: original.ownerId,
        deviceId: original.deviceId,
        scopeFingerprint: original.scopeFingerprint,
        authorizationEpoch: original.authorizationEpoch,
        resourceKey: original.resourceKey,
        version: original.version,
        sha256: Buffer.from(original.sha256, 'hex'),
        bytes: original.bytes,
        writerId: writer.id,
        writerOwnerId: writer.ownerId,
      })
      .onConflict((oc) => oc.columns(['readId', 'claimFence']).doNothing())
      .returning(['id'])
      .executeTakeFirst();
  }

  /** Filesystem preflight stays outside source/claim transactions; reserve revalidates the snapshot. */
  async inspectDisk(root: string) {
    const entries = await this.db
      .selectFrom('source_resource_cache')
      .select(['id', 'bytes'])
      .limit(MAX_CACHE_ENTRIES)
      .execute();
    if (entries.length >= MAX_CACHE_ENTRIES || !(await sourceCacheDiskIsAccounted(root, entries))) return;
    return entries;
  }

  /** Only after the receiver has closed its output and completed on-disk verification. */
  async publishVerified(
    tx: Transaction<DB>,
    id: string,
    writer: { id: string; ownerId: string },
    file: { fileName: string; bytes: number; sha256: Buffer },
  ) {
    if (
      !/^[a-f0-9-]{36}[.]artifact$/u.test(file.fileName) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.sha256.length !== 32
    )
      return false;
    const row = await tx
      .updateTable('source_resource_cache')
      .set({ state: 'ready', fileName: file.fileName, writerStoppedAt: sql`clock_timestamp()` })
      .where('id', '=', id)
      .where('writerId', '=', writer.id)
      .where('writerOwnerId', '=', writer.ownerId)
      .where('state', '=', 'writing')
      .where('restoreHeld', '=', false)
      .where('writerStoppedAt', 'is', null)
      .where('bytes', '=', file.bytes)
      .where('sha256', '=', file.sha256)
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  /** Positive writer completion; neither age nor a missing heartbeat proves it stopped. */
  async finishWriter(id: string, writer: { id: string; ownerId: string }) {
    return !!(await this.db
      .updateTable('source_resource_cache')
      .set({ writerStoppedAt: sql`clock_timestamp()` })
      .where('id', '=', id)
      .where('writerId', '=', writer.id)
      .where('writerOwnerId', '=', writer.ownerId)
      .where('state', '=', 'writing')
      .where('restoreHeld', '=', false)
      .returning('id')
      .executeTakeFirst());
  }

  pin(id: string, reader: SourceCacheReader) {
    return this.db.transaction().execute((tx) => this.pinInTransaction(tx, id, reader));
  }

  async pinInTransaction(tx: Transaction<DB>, id: string, reader: SourceCacheReader) {
    const row = await tx
      .selectFrom('source_resource_cache')
      .select('id')
      .where('id', '=', id)
      .where('state', '=', 'ready')
      .where('restoreHeld', '=', false)
      .where('writerStoppedAt', 'is not', null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return;
    await tx
      .deleteFrom('source_resource_cache_lease')
      .where('cacheId', '=', id)
      .where('readerStoppedAt', 'is not', null)
      .execute();
    const usage = await tx
      .selectFrom('source_resource_cache_lease')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('cacheId', '=', id)
      .executeTakeFirstOrThrow();
    if (Number(usage.count) >= MAX_CACHE_READERS) return;
    return tx
      .insertInto('source_resource_cache_lease')
      .values({
        cacheId: id,
        readerId: reader.readerId,
        readerOwnerId: reader.ownerId,
        kind: reader.kind,
        jobId: reader.kind === 'job' ? reader.jobId : null,
        attemptToken: reader.kind === 'job' ? reader.attemptToken : null,
      })
      .onConflict((oc) => oc.columns(['cacheId', 'readerId']).doNothing())
      .returning('id')
      .executeTakeFirst();
  }

  private async readerStops(tx: Transaction<DB>, cacheId: string) {
    const value = (
      await sql<{ value: unknown }>`SELECT value FROM system_metadata WHERE key=${readerStopKey(cacheId)}`.execute(tx)
    ).rows[0]?.value;
    if (value === undefined) return {} as Record<string, true>;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length > MAX_CACHE_READERS ||
      Object.entries(value).some(([id, stopped]) => !leaseId(id) || stopped !== true)
    )
      throw new Error('source_reader_cleanup_invalid');
    return value as Record<string, true>;
  }

  private async forgetReaderStop(tx: Transaction<DB>, cacheId: string, id: string) {
    const key = readerStopKey(cacheId);
    await sql`UPDATE system_metadata SET value=value-${id}::text WHERE key=${key}`.execute(tx);
    await sql`DELETE FROM system_metadata WHERE key=${key} AND value='{}'::jsonb`.execute(tx);
  }

  /** Caller has joined descriptor closure and every native borrower before releasing. */
  async release(
    id: string,
    reader: Pick<SourceCacheReader, 'readerId' | 'ownerId'>,
    afterStopped?: () => Promise<void>,
  ) {
    const lease = await this.db
      .selectFrom('source_resource_cache_lease')
      .select('cacheId')
      .where('id', '=', id)
      .where('readerId', '=', reader.readerId)
      .where('readerOwnerId', '=', reader.ownerId)
      .executeTakeFirst();
    if (!lease) return false;
    const cacheId = lease.cacheId;
    // The journal survives pin-slot pruning and commits before filesystem cleanup can fail.
    const stopped = await this.db.transaction().execute(async (tx) => {
      if (
        !(await tx
          .selectFrom('source_resource_cache')
          .select('id')
          .where('id', '=', cacheId)
          .forUpdate()
          .executeTakeFirst())
      )
        return false;
      const row = await tx
        .updateTable('source_resource_cache_lease')
        .set({ readerStoppedAt: sql`coalesce("readerStoppedAt",clock_timestamp())` })
        .where('id', '=', id)
        .where('readerId', '=', reader.readerId)
        .where('readerOwnerId', '=', reader.ownerId)
        .returning('id')
        .executeTakeFirst();
      if (!row) return false;
      const receipts = await this.readerStops(tx, cacheId);
      if (Object.keys(receipts).length >= MAX_CACHE_READERS && !receipts[id])
        throw new Error('source_reader_cleanup_busy');
      await sql`INSERT INTO system_metadata(key,value) VALUES (${readerStopKey(cacheId)},jsonb_build_object(${id}::text,true))
        ON CONFLICT(key) DO UPDATE SET value=system_metadata.value || EXCLUDED.value`.execute(tx);
      return true;
    });
    if (!stopped) return false;
    await afterStopped?.();
    return this.db.transaction().execute(async (tx) => {
      if (
        !(await tx
          .selectFrom('source_resource_cache')
          .select('id')
          .where('id', '=', cacheId)
          .forUpdate()
          .executeTakeFirst())
      )
        return false;
      const removed = await tx
        .deleteFrom('source_resource_cache_lease')
        .where('id', '=', id)
        .where('readerId', '=', reader.readerId)
        .where('readerOwnerId', '=', reader.ownerId)
        .returning('id')
        .executeTakeFirst();
      if (afterStopped) await this.forgetReaderStop(tx, cacheId, id);
      return !!removed;
    });
  }

  /** Candidates are hints; claimRemoval rechecks every lifetime fence before deletion. */
  removalCandidates() {
    return this.db
      .selectFrom('source_resource_cache')
      .select('id')
      .where((eb) => eb.or([eb('restoreHeld', '=', true), eb('writerStoppedAt', 'is not', null)]))
      .where((eb) =>
        eb.or([
          eb('restoreHeld', '=', true),
          eb.not(
            eb.exists(
              eb
                .selectFrom('source_resource_cache_lease')
                .select('id')
                .whereRef('cacheId', '=', 'source_resource_cache.id')
                .where('readerStoppedAt', 'is', null),
            ),
          ),
        ]),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('source_resource_read')
              .select('id')
              .whereRef('id', '=', 'source_resource_cache.readId')
              .where('state', '!=', 'unavailable')
              .where(sourceReadHasInterest)
              .where('deadline', '>', sql<Date>`clock_timestamp()`),
          ),
        ),
      )
      .orderBy('createdAt')
      .orderBy('id')
      .limit(MAX_CACHE_ENTRIES)
      .execute();
  }

  claimRemoval(id: string, options: { expiredOnly?: boolean; root?: string } = {}) {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('source_resource_cache')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return;
      if (options.root) {
        for (const id of Object.keys(await this.readerStops(tx, row.id))) {
          await removeSourceCacheReaderMarker(options.root, row.id, id);
          await this.forgetReaderStop(tx, row.id, id);
        }
      }
      if (row.restoreHeld) {
        if (!options.root || !(await sourceCacheClosedMatches(options.root, row))) return;
        // The filesystem receipt covers readers missing from (or resurrected by) this snapshot.
        await tx.deleteFrom('source_resource_cache_lease').where('cacheId', '=', id).execute();
      } else if (!row.writerStoppedAt) return;
      // Older waiters have no per-consumer record; known readers leaving cannot revoke their live deadline.
      const request = await tx
        .selectFrom('source_resource_read')
        .select('id')
        .where('id', '=', row.readId)
        .where('state', '!=', 'unavailable')
        .where(options.expiredOnly ? sourceReadHasInterest : sql<boolean>`NOT "consumerManaged"`)
        .where('deadline', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (request) return;
      await tx
        .deleteFrom('source_resource_cache_lease')
        .where('cacheId', '=', id)
        .where('readerStoppedAt', 'is not', null)
        .execute();
      const active = await tx
        .selectFrom('source_resource_cache_lease')
        .select('id')
        .where('cacheId', '=', id)
        .limit(1)
        .executeTakeFirst();
      if (active) return;
      const waiting = await tx
        .selectFrom('source_resource_read_consumer as consumer')
        .innerJoin('source_resource_read as request', 'request.id', 'consumer.readId')
        .select('consumer.id')
        .where('consumer.readId', '=', row.readId)
        .where((eb) =>
          eb.or([eb('consumer.expiresAt', 'is', null), eb('consumer.expiresAt', '>', sql<Date>`clock_timestamp()`)]),
        )
        .where('request.state', '=', 'ready')
        .where('request.deadline', '>', sql<Date>`clock_timestamp()`)
        .limit(1)
        .executeTakeFirst();
      if (waiting) return;
      await tx
        .updateTable('source_resource_cache')
        .set({
          state: 'deleting',
          restoreHeld: false,
          writerStoppedAt: sql`coalesce("writerStoppedAt",clock_timestamp())`,
        })
        .where('id', '=', id)
        .execute();
      return { ...row, state: 'deleting' as const, restoreHeld: false };
    });
  }

  /** Call only after the private object directory was removed; deleting still reserves its bytes. */
  async confirmRemoved(id: string) {
    return this.db.transaction().execute(async (tx) => {
      const removed = await tx
        .deleteFrom('source_resource_cache')
        .where('id', '=', id)
        .where('state', '=', 'deleting')
        .where('restoreHeld', '=', false)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('source_resource_cache_lease')
                .select('id')
                .whereRef('cacheId', '=', 'source_resource_cache.id'),
            ),
          ),
        )
        .returning('id')
        .executeTakeFirst();
      if (removed) await sql`DELETE FROM system_metadata WHERE key=${readerStopKey(id)}`.execute(tx);
      return !!removed;
    });
  }
}
