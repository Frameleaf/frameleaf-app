import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database.js';
import { ArchiveOperationCreateDto, ArchiveOperationResponseDto } from 'src/dtos/archive-operation.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetVisibility, Permission } from 'src/enum.js';
import { isForkWriteEnabled } from 'src/fork-schema/authority.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ForkSchemaPhase } from 'src/repositories/fork-schema.repository.js';
import { DB } from 'src/schema/index.js';
import { checkAccess } from 'src/utils/access.js';
import { hiddenContentAssetIdExists } from 'src/utils/database.js';
import { getPreferences } from 'src/utils/preferences.js';

type Operation = {
  id: string;
  ownerId: string;
  sessionId: string;
  requestKey: string;
  scope: string;
  assetIds: string[];
  cancelled: boolean;
  undo: boolean;
};
type Status = 'pending' | 'succeeded' | 'skipped' | 'revoked' | 'error' | 'undone' | 'conflict';
type Item = {
  assetId: string;
  status: Status;
  previousVisibility: AssetVisibility | null;
  publishedUpdateId: string | null;
};

@Injectable()
export class ArchiveOperationRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  private async lockWrites(tx: Transaction<DB>) {
    const { rows } = await sql<{
      phase: ForkSchemaPhase;
    }>`SELECT phase FROM immich_fork.state WHERE id=1 FOR SHARE`.execute(tx);
    const handoff = await sql`SELECT 1 FROM immich_fork.migration_audit WHERE status='running'
      AND name IN ('official-handoff-preparation','fork-return-reconciliation') LIMIT 1`.execute(tx);
    if (!rows[0] || !isForkWriteEnabled(rows[0].phase) || handoff.rows.length > 0) {
      throw new ConflictException('Archive operations are unavailable during database handoff');
    }
  }

  async create(auth: AuthDto, dto: ArchiveOperationCreateDto): Promise<string> {
    if (!auth.session || auth.apiKey || auth.sharedLink)
      throw new BadRequestException('A signed-in session is required');
    const ids = [...new Set(dto.ids)].sort();
    return this.db.transaction().execute(async (tx) => {
      await this.lockWrites(tx);
      const { rows } = await sql<Operation>`INSERT INTO immich_fork.archive_operation
        ("ownerId","sessionId","requestKey",scope,"assetIds")
        VALUES (${auth.user.id}::uuid,${auth.session!.id}::uuid,${dto.requestKey}::uuid,${dto.scope},${ids}::uuid[])
        ON CONFLICT ("ownerId","requestKey") DO NOTHING RETURNING *`.execute(tx);
      let operation = rows[0];
      if (!operation) {
        const previous = await sql<Operation>`SELECT * FROM immich_fork.archive_operation
          WHERE "ownerId"=${auth.user.id}::uuid AND "requestKey"=${dto.requestKey}::uuid FOR UPDATE`.execute(tx);
        operation = previous.rows[0];
      }
      if (operation.scope !== dto.scope || JSON.stringify(operation.assetIds) !== JSON.stringify(ids)) {
        throw new ConflictException('The request key belongs to a different selection');
      }
      if (rows[0]) {
        await sql`INSERT INTO immich_fork.archive_operation_item ("operationId","assetId")
          SELECT ${operation.id}::uuid,unnest(${ids}::uuid[])`.execute(tx);
      }
      return operation.id;
    });
  }

  async list(ownerId: string, id?: string): Promise<ArchiveOperationResponseDto[]> {
    // ponytail: aggregate history in one query; paginate if operation history becomes large.
    // No retained asset identities leave this repository. Counts share one database snapshot.
    const { rows } = await sql<ArchiveOperationResponseDto>`SELECT o.id,o.scope,
      cardinality(o."assetIds") AS count,o.cancelled,o.undo,
      count(*) FILTER (WHERE i.status='pending')::int AS pending,
      count(*) FILTER (WHERE i.status='succeeded')::int AS succeeded,
      count(*) FILTER (WHERE i.status='skipped')::int AS skipped,
      count(*) FILTER (WHERE i.status='revoked')::int AS revoked,
      count(*) FILTER (WHERE i.status='error')::int AS error,
      count(*) FILTER (WHERE i.status='undone')::int AS undone,
      count(*) FILTER (WHERE i.status='conflict')::int AS conflict
      FROM immich_fork.archive_operation o JOIN immich_fork.archive_operation_item i ON i."operationId"=o.id
      WHERE o."ownerId"=${ownerId}::uuid AND (${id ?? null}::uuid IS NULL OR o.id=${id ?? null}::uuid)
      GROUP BY o.id ORDER BY o."createdAt" DESC`.execute(this.db);
    return rows;
  }

  async get(ownerId: string, id: string): Promise<ArchiveOperationResponseDto> {
    const [operation] = await this.list(ownerId, id);
    if (!operation) throw new NotFoundException();
    return operation;
  }

  async command(auth: AuthDto, id: string, command: 'cancel' | 'retry' | 'undo') {
    if (!auth.session || auth.apiKey || auth.sharedLink)
      throw new BadRequestException('A signed-in session is required');
    await this.db.transaction().execute(async (tx) => {
      await this.lockWrites(tx);
      const { rows } = await sql<Operation>`SELECT * FROM immich_fork.archive_operation
        WHERE id=${id}::uuid AND "ownerId"=${auth.user.id}::uuid FOR UPDATE`.execute(tx);
      const operation = rows[0];
      if (!operation) throw new NotFoundException();
      if (command === 'cancel') {
        await sql`UPDATE immich_fork.archive_operation SET cancelled=true WHERE id=${id}::uuid`.execute(tx);
        return;
      }
      if (command === 'undo' && !operation.cancelled) {
        const pending = await sql`SELECT 1 FROM immich_fork.archive_operation_item
          WHERE "operationId"=${id}::uuid AND status='pending' LIMIT 1`.execute(tx);
        if (pending.rows.length > 0) throw new ConflictException('Cancel or finish the archive before undoing it');
      }
      const undo = operation.undo || command === 'undo';
      await sql`UPDATE immich_fork.archive_operation SET cancelled=false,undo=${undo},"sessionId"=${auth.session!.id}::uuid
        WHERE id=${id}::uuid`.execute(tx);
      if (command === 'retry') {
        await sql`UPDATE immich_fork.archive_operation_item SET status='pending'
          WHERE "operationId"=${id}::uuid AND status IN ('error','revoked')
          AND (${!undo} OR "publishedUpdateId" IS NOT NULL)`.execute(tx);
      } else if (command === 'undo') {
        await sql`UPDATE immich_fork.archive_operation_item SET status='pending'
          WHERE "operationId"=${id}::uuid AND status='succeeded'`.execute(tx);
      }
    });
  }

  async pending(): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`SELECT id FROM immich_fork.archive_operation o
      WHERE NOT cancelled AND EXISTS (SELECT 1 FROM immich_fork.archive_operation_item i
        WHERE i."operationId"=o.id AND i.status='pending') ORDER BY "createdAt" LIMIT 100`.execute(this.db);
    return rows.map(({ id }) => id);
  }

  async processNext(id: string, includeNsfw: boolean): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await this.lockWrites(tx);
      // One item per transaction: cancellation and duplicate workers serialize with publication.
      const operations =
        await sql<Operation>`SELECT * FROM immich_fork.archive_operation WHERE id=${id}::uuid FOR UPDATE`.execute(tx);
      const operation = operations.rows[0];
      if (!operation || operation.cancelled) return false;
      const items = await sql<Item>`SELECT * FROM immich_fork.archive_operation_item
        WHERE "operationId"=${id}::uuid AND status='pending' ORDER BY "assetId" LIMIT 1 FOR UPDATE`.execute(tx);
      const item = items.rows[0];
      if (!item) return false;
      const setStatus = (status: Status) =>
        sql`UPDATE immich_fork.archive_operation_item SET status=${status}
        WHERE "operationId"=${id}::uuid AND "assetId"=${item.assetId}::uuid`.execute(tx);
      await sql`SAVEPOINT archive_item`.execute(tx);
      try {
        const user = await tx
          .selectFrom('user')
          .select(columns.authUser)
          .where('id', '=', operation.ownerId)
          .where('deletedAt', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        const session = await tx
          .selectFrom('session')
          .selectAll()
          .where('id', '=', operation.sessionId)
          .where('userId', '=', operation.ownerId)
          .forUpdate()
          .executeTakeFirst();
        if (!user || !session) {
          await setStatus('revoked');
          return true;
        }
        const metadata = await tx
          .selectFrom('user_metadata')
          .selectAll()
          .where('userId', '=', user.id)
          .forShare()
          .execute();
        const asset = await tx
          .selectFrom('asset')
          .select(['id', 'visibility', 'updateId', 'ownerId', 'deletedAt'])
          .where('id', '=', item.assetId)
          .forUpdate()
          .executeTakeFirst();
        await sql`SELECT 1 FROM immich_fork.asset_privacy WHERE "assetId"=${item.assetId}::uuid FOR SHARE`.execute(tx);
        const clock = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx);
        const now = clock.rows[0].now;
        if (session.expiresAt && session.expiresAt <= now) {
          await setStatus('revoked');
          return true;
        }
        const elevated = !!session.pinExpiresAt && session.pinExpiresAt > now;
        const auth: AuthDto = {
          user,
          session: { id: session.id, hasElevatedPermission: elevated },
          hiddenContent: elevated
            ? undefined
            : { userId: user.id, includeNsfw, ...getPreferences(metadata).privacy.suppression },
        };
        const allowed = await checkAccess(new AccessRepository(tx), {
          auth,
          permission: Permission.AssetUpdate,
          ids: [item.assetId],
        });
        if (!asset || !allowed.has(item.assetId)) {
          await setStatus('revoked');
          return true;
        }
        if (asset.deletedAt || (!operation.undo && asset.visibility !== AssetVisibility.Timeline)) {
          await setStatus('skipped');
          return true;
        }
        if (
          operation.undo &&
          (asset.visibility !== AssetVisibility.Archive || asset.updateId !== item.publishedUpdateId)
        ) {
          await setStatus('conflict');
          return true;
        }
        if (operation.undo && !item.previousVisibility) {
          await setStatus('skipped');
          return true;
        }
        const updated = await tx
          .updateTable('asset')
          .set({ visibility: operation.undo ? item.previousVisibility! : AssetVisibility.Archive })
          .where('id', '=', asset.id)
          .$if(!!auth.hiddenContent, (query) =>
            query.where(sql<boolean>`not ${hiddenContentAssetIdExists(sql.ref('asset.id'), auth.hiddenContent!)}`),
          )
          .where(
            sql<boolean>`EXISTS (SELECT 1 FROM session WHERE id=${session.id}::uuid
          AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())
          AND (${!elevated} OR "pinExpiresAt">clock_timestamp()))`,
          )
          .returning('updateId')
          .executeTakeFirst();
        if (!updated) {
          await setStatus('revoked');
          return true;
        }
        await sql`UPDATE immich_fork.archive_operation_item SET status=${operation.undo ? 'undone' : 'succeeded'},
        "previousVisibility"=${operation.undo ? item.previousVisibility : asset.visibility},
        "publishedUpdateId"=${updated.updateId}::uuid WHERE "operationId"=${id}::uuid AND "assetId"=${asset.id}::uuid`.execute(
          tx,
        );
        return true;
      } catch {
        await sql`ROLLBACK TO SAVEPOINT archive_item`.execute(tx);
        await setStatus('error');
        return true;
      }
    });
  }
}
