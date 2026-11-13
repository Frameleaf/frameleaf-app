import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { PhotographyCampaignSaveDto } from 'src/dtos/photography-campaign.dto.js';
import type { DB } from 'src/schema/index.js';

export type CampaignRow = PhotographyCampaignSaveDto & {
  id: string;
  ownerId: string;
  revision: string;
  status: 'draft' | 'scheduled' | 'completed' | 'cancelled';
  scheduledFor: Date | null;
  sentCount: number;
  failedCount: number;
  pendingCount: number;
  uncertainCount: number;
  unsubscribedCount: number;
};
export type CampaignContact = { id: string; email: string; name: string; unsubscribeToken: string };
const counts = sql`c.*,
  (SELECT count(*)::int FROM photography_campaign_delivery d WHERE d."campaignId"=c.id AND d.status='sent') AS "sentCount",
  (SELECT count(*)::int FROM photography_campaign_delivery d WHERE d."campaignId"=c.id AND d.status='failed') AS "failedCount",
  (SELECT count(*)::int FROM photography_campaign_delivery d WHERE d."campaignId"=c.id AND d.status='pending') AS "pendingCount",
  (SELECT count(*)::int FROM photography_campaign_delivery d WHERE d."campaignId"=c.id AND d.status='uncertain') AS "uncertainCount",
  (SELECT count(*)::int FROM photography_campaign_delivery d WHERE d."campaignId"=c.id AND d.status='unsubscribed') AS "unsubscribedCount"`;

@Injectable()
export class PhotographyCampaignRepository {
  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  async syncContacts(ownerId: string) {
    await sql`INSERT INTO photography_contact ("ownerId", email, name, source)
      SELECT DISTINCT ON (email) ${ownerId}::uuid, email, name, source FROM (
        SELECT lower(trim(r->>'email')) email, coalesce(r->>'name','') name, 'clients' source
        FROM photography_workflow w CROSS JOIN LATERAL jsonb_array_elements(coalesce(w.value->'recipients','[]')) r
        WHERE w."ownerId"=${ownerId}::uuid AND coalesce((r->>'revoked')::boolean,false)=false
        UNION ALL SELECT lower(trim(i->>'email')), coalesce(i->>'name',''), 'leads'
        FROM photography_studio_site s CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.value->'inquiries','[]')) i
        WHERE s."ownerId"=${ownerId}::uuid
      ) sources WHERE email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      ORDER BY email, source
      ON CONFLICT ("ownerId", email) DO UPDATE SET name=excluded.name,
        source=CASE WHEN photography_contact.source='clients' THEN 'clients' ELSE excluded.source END`.execute(this.db);
  }
  async list(ownerId: string) {
    const { rows } =
      await sql<CampaignRow>`SELECT ${counts} FROM photography_campaign c WHERE c."ownerId"=${ownerId}::uuid ORDER BY c."createdAt" DESC`.execute(
        this.db,
      );
    return rows;
  }
  async get(ownerId: string, id: string) {
    const { rows } =
      await sql<CampaignRow>`SELECT ${counts} FROM photography_campaign c WHERE c.id=${id}::uuid AND c."ownerId"=${ownerId}::uuid`.execute(
        this.db,
      );
    if (!rows[0]) throw new NotFoundException('Campaign is unavailable');
    return rows[0];
  }
  async save(ownerId: string, id: string, draft: PhotographyCampaignSaveDto) {
    const { name, templateKey, subject, body, audience } = draft;
    const { rows } = await sql`INSERT INTO photography_campaign (id,"ownerId",name,"templateKey",subject,body,audience)
      VALUES (${id}::uuid,${ownerId}::uuid,${name},${templateKey},${subject},${body},${JSON.stringify(audience)}::text::jsonb)
      ON CONFLICT (id) DO UPDATE SET name=excluded.name,"templateKey"=excluded."templateKey",subject=excluded.subject,body=excluded.body,audience=excluded.audience,revision=gen_random_uuid()
      WHERE photography_campaign."ownerId"=${ownerId}::uuid AND photography_campaign.status='draft'
      RETURNING id`.execute(this.db);
    if (rows.length === 0) throw new ConflictException('Campaign can no longer be edited');
    return this.get(ownerId, id);
  }
  async contacts(ownerId: string, audience: PhotographyCampaignSaveDto['audience']) {
    const shoot = audience.source === 'shoot';
    const { rows } = await sql<CampaignContact>`SELECT id,email,name,"unsubscribeToken" FROM photography_contact p
      WHERE "ownerId"=${ownerId}::uuid AND "unsubscribedAt" IS NULL
      ${['clients', 'leads'].includes(audience.source) ? sql`AND source=${audience.source}` : sql``}
      ${
        shoot
          ? sql`AND EXISTS (SELECT 1 FROM photography_workflow w CROSS JOIN LATERAL jsonb_array_elements(coalesce(w.value->'recipients','[]')) r
        WHERE w.id=${audience.workflowId ?? null}::uuid AND w."ownerId"=${ownerId}::uuid AND lower(trim(r->>'email'))=p.email AND NOT coalesce((r->>'revoked')::boolean,false))`
          : sql``
      }
      ORDER BY id`.execute(this.db);
    return rows;
  }
  async schedule(ownerId: string, id: string, when: Date, contactIds: string[], revision: string) {
    await this.db.transaction().execute(async (tx) => {
      const { rows } =
        await sql`SELECT id FROM photography_campaign WHERE id=${id}::uuid AND "ownerId"=${ownerId}::uuid AND status='draft' AND revision=${revision}::uuid FOR UPDATE`.execute(
          tx,
        );
      if (rows.length === 0) throw new ConflictException('Campaign is already scheduled');
      await sql`INSERT INTO photography_campaign_delivery ("campaignId","contactId")
        SELECT ${id}::uuid,id FROM photography_contact WHERE "ownerId"=${ownerId}::uuid AND "unsubscribedAt" IS NULL AND id=ANY(${contactIds}::uuid[])
        ON CONFLICT DO NOTHING`.execute(tx);
      await sql`UPDATE photography_campaign SET status='scheduled',"scheduledFor"=${when} WHERE id=${id}::uuid`.execute(
        tx,
      );
    });
  }
  async cancel(ownerId: string, id: string) {
    await sql`UPDATE photography_campaign SET status='cancelled' WHERE id=${id}::uuid AND "ownerId"=${ownerId}::uuid AND status IN ('draft','scheduled')`.execute(
      this.db,
    );
    return this.get(ownerId, id);
  }
  async reserveTest(ownerId: string, id: string) {
    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(1083002)`.execute(tx);
      const recent =
        await sql`SELECT 1 FROM photography_campaign WHERE "lastTestAt">now()-interval '1 minute' LIMIT 1`.execute(tx);
      if (recent.rows.length > 0) return false;
      const { rows } =
        await sql`UPDATE photography_campaign SET "lastTestAt"=now() WHERE id=${id}::uuid AND "ownerId"=${ownerId}::uuid RETURNING id`.execute(
          tx,
        );
      return rows.length > 0;
    });
  }
  async due() {
    const { rows } = await sql<{
      id: string;
      ownerId: string;
    }>`SELECT id,"ownerId" FROM photography_campaign WHERE status='scheduled' AND "scheduledFor"<=now() AND NOT EXISTS (SELECT 1 FROM photography_campaign WHERE "pausedUntil">now()) ORDER BY "scheduledFor",id LIMIT 50`.execute(
      this.db,
    );
    return rows;
  }
  async claim(id: string): Promise<CampaignContact | undefined> {
    return this.db.transaction().execute(async (tx) => {
      // The single configured sending account shares this durable pacing boundary across workers.
      await sql`SELECT pg_advisory_xact_lock(1083001)`.execute(tx);
      const pause = await sql`SELECT 1 FROM photography_campaign WHERE "pausedUntil">now() LIMIT 1`.execute(tx);
      if (pause.rows.length > 0) return;
      const recent =
        await sql`SELECT 1 FROM photography_campaign_delivery WHERE "attemptedAt">now()-interval '2 seconds' LIMIT 1`.execute(
          tx,
        );
      if (recent.rows.length > 0) return;
      await sql`UPDATE photography_campaign_delivery d SET status='unsubscribed' FROM photography_contact p WHERE d."campaignId"=${id}::uuid AND d."contactId"=p.id AND d.status='pending' AND p."unsubscribedAt" IS NOT NULL`.execute(
        tx,
      );
      const { rows } =
        await sql<CampaignContact>`SELECT p.id,p.email,p.name,p."unsubscribeToken" FROM photography_campaign_delivery d
        JOIN photography_contact p ON p.id=d."contactId" JOIN photography_campaign c ON c.id=d."campaignId"
        WHERE d."campaignId"=${id}::uuid AND d.status='pending' AND p."unsubscribedAt" IS NULL AND c.status='scheduled' AND c."scheduledFor"<=now()
        ORDER BY p.id LIMIT 1 FOR UPDATE OF d,p,c SKIP LOCKED`.execute(tx);
      const contact = rows[0];
      if (contact)
        await sql`UPDATE photography_campaign_delivery SET status='uncertain',"attemptedAt"=now() WHERE "campaignId"=${id}::uuid AND "contactId"=${contact.id}::uuid`.execute(
          tx,
        );
      return contact;
    });
  }
  async sendIfEligible(id: string, contactId: string, send: () => Promise<unknown>) {
    return this.db.transaction().execute(async (tx) => {
      // An opt-out or cancellation commits after any send already in progress, and blocks every later send.
      const { rows } =
        await sql`SELECT p.id FROM photography_contact p JOIN photography_campaign c ON c."ownerId"=p."ownerId"
        WHERE p.id=${contactId}::uuid AND c.id=${id}::uuid AND p."unsubscribedAt" IS NULL AND c.status='scheduled' FOR UPDATE OF p,c`.execute(
          tx,
        );
      if (rows.length === 0) return false;
      await send();
      return true;
    });
  }
  async finish(id: string, contactId: string, status: 'sent' | 'failed' | 'unsubscribed' | 'pending') {
    await sql`UPDATE photography_campaign_delivery SET status=${status} WHERE "campaignId"=${id}::uuid AND "contactId"=${contactId}::uuid AND status='uncertain'`.execute(
      this.db,
    );
  }
  async pause(id: string, seconds: number) {
    await sql`UPDATE photography_campaign SET "pausedUntil"=now()+(${seconds}::integer * interval '1 second') WHERE id=${id}::uuid`.execute(
      this.db,
    );
  }
  async complete(id: string) {
    await sql`UPDATE photography_campaign SET status='completed' WHERE id=${id}::uuid AND status='scheduled'
      AND NOT EXISTS (SELECT 1 FROM photography_campaign_delivery WHERE "campaignId"=${id}::uuid AND (status='pending' OR (status='uncertain' AND "attemptedAt">now()-interval '10 minutes')))`.execute(
      this.db,
    );
  }
  async deliveries(id: string) {
    const { rows } = await sql<{
      email: string;
      name: string;
      status: 'pending' | 'sent' | 'failed' | 'uncertain' | 'unsubscribed';
    }>`SELECT p.email,p.name,d.status FROM photography_campaign_delivery d JOIN photography_contact p ON p.id=d."contactId" WHERE d."campaignId"=${id}::uuid ORDER BY d.status,p.email`.execute(
      this.db,
    );
    return { items: rows };
  }
  async unsubscribe(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const { rows } =
      await sql`UPDATE photography_contact SET "unsubscribedAt"=coalesce("unsubscribedAt",now()) WHERE "unsubscribeToken"=${token} RETURNING id`.execute(
        this.db,
      );
    return rows.length > 0;
  }
}
