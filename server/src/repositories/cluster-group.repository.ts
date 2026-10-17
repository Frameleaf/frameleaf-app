import { ConflictException, Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { publicationDatabase, publicationTransaction } from 'src/queue/transaction.js';
import { DB } from 'src/schema/index.js';
import { ClusterGroupRequestTable } from 'src/schema/tables/cluster-group-request.table.js';

@Injectable()
export class ClusterGroupRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {
    this.db = publicationDatabase(this.db);
  }

  async withMembershipChange<T>(userId: string, change: (sourceGroupId: string) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      // Serialize departures without blocking foreign keys when another account joins this group.
      const group = await tx
        .selectFrom('cluster_group')
        .select('id')
        .where('id', '=', (eb) =>
          eb.selectFrom('user').select('clusterGroupId').where('id', '=', userId).where('deletedAt', 'is', null),
        )
        .forNoKeyUpdate()
        .executeTakeFirst();
      const user = await tx
        .selectFrom('user')
        .select('clusterGroupId')
        .where('id', '=', userId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!group || user?.clusterGroupId !== group.id) {
        throw new ConflictException('Cluster membership changed; retry the operation');
      }
      return publicationTransaction.run(tx, () => change(group.id));
    });
  }

  @GenerateSql()
  create() {
    return this.db.insertInto('cluster_group').defaultValues().returningAll().executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [{ clusterGroupId: DummyValue.UUID, userId: DummyValue.UUID }] })
  async hasOtherMembers({ clusterGroupId, userId }: { clusterGroupId: string; userId: string }): Promise<boolean> {
    const member = await this.db
      .selectFrom('user')
      .select('user.id')
      .where('user.clusterGroupId', '=', clusterGroupId)
      .where('user.id', '!=', userId)
      .where('user.deletedAt', 'is', null)
      .limit(1)
      .executeTakeFirst();

    return !!member;
  }

  @GenerateSql({ params: [{ clusterGroupId: DummyValue.UUID, userId: DummyValue.UUID }] })
  createRequest(request: Insertable<ClusterGroupRequestTable>) {
    return this.db
      .insertInto('cluster_group_request')
      .values(request)
      .onConflict((oc) =>
        // the update is pointless, but required for the query to return the conflicting row
        oc.columns(['clusterGroupId', 'userId']).doUpdateSet({ clusterGroupId: request.clusterGroupId }),
      )
      .returningAll()
      .returning(sql<boolean>`(xmax = 0)`.as('isInserted'))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getRequest(id: string, lock = false) {
    return this.db
      .selectFrom('cluster_group_request')
      .selectAll('cluster_group_request')
      .where('cluster_group_request.id', '=', id)
      .$if(lock, (qb) => qb.forUpdate())
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, clusterGroupId: DummyValue.UUID }] })
  searchRequests({ userId, clusterGroupId }: { userId?: string; clusterGroupId?: string } = {}) {
    return this.db
      .selectFrom('cluster_group_request')
      .selectAll('cluster_group_request')
      .$if(!!userId, (qb) => qb.where('cluster_group_request.userId', '=', userId!))
      .$if(!!clusterGroupId, (qb) => qb.where('cluster_group_request.clusterGroupId', '=', clusterGroupId!))
      .orderBy('cluster_group_request.createdAt', 'asc')
      .execute();
  }

  @GenerateSql({ params: [{ clusterGroupId: DummyValue.UUID, userId: DummyValue.UUID }] })
  getUsers({ clusterGroupId, userId }: { clusterGroupId: string; userId: string }) {
    return this.db
      .selectFrom('user')
      .select(columns.user)
      .where('user.clusterGroupId', '=', clusterGroupId)
      .where('user.deletedAt', 'is', null)
      .orderBy((eb) => eb('user.id', '=', userId), 'desc')
      .orderBy('user.name', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteRequest(id: string): Promise<void> {
    await this.db.deleteFrom('cluster_group_request').where('cluster_group_request.id', '=', id).execute();
  }
}
