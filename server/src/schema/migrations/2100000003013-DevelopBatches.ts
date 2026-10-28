import { Kysely, sql } from 'kysely';

export async function up(db:Kysely<any>):Promise<void>{
  await sql`CREATE TABLE develop_batch(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,status text NOT NULL DEFAULT 'open',"includeSidecars" boolean NOT NULL DEFAULT true,"createdAt" timestamptz NOT NULL DEFAULT now(), CONSTRAINT develop_batch_status_check CHECK(status IN ('open','cancelled')))`.execute(db);
  await sql`CREATE INDEX "IDX_develop_batch_ownerId" ON develop_batch("ownerId")`.execute(db);
  await sql`CREATE TABLE develop_batch_item(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"batchId" uuid NOT NULL REFERENCES develop_batch(id) ON DELETE CASCADE,"assetId" uuid NOT NULL,"exportId" uuid REFERENCES develop_export(id) ON DELETE SET NULL,"exportName" text NOT NULL,"fileName" text NOT NULL,"hasSidecar" boolean NOT NULL DEFAULT false,error text,"errorCode" text,status text NOT NULL DEFAULT 'pending',"createdAt" timestamptz NOT NULL DEFAULT now(), CONSTRAINT develop_batch_item_status_check CHECK(status IN ('pending','prepared','failed')))`.execute(db);
  await sql`CREATE UNIQUE INDEX "IDX_develop_batch_item_batchId_assetId" ON develop_batch_item("batchId","assetId")`.execute(db);
  await sql`CREATE INDEX "IDX_develop_batch_item_assetId" ON develop_batch_item("assetId")`.execute(db);
  await sql`CREATE INDEX "IDX_develop_batch_item_exportId" ON develop_batch_item("exportId")`.execute(db);
  await sql`CREATE TABLE develop_batch_return(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"itemId" uuid NOT NULL REFERENCES develop_batch_item(id) ON DELETE CASCADE,checksum text NOT NULL,"confirmationId" uuid NOT NULL,"expectedCurrentRevisionId" uuid,"activationInvalidated" boolean NOT NULL DEFAULT false,"revisionId" uuid,"sourceIdentity" bytea,"pendingMasterPath" text,"stagedAt" timestamptz,locked boolean NOT NULL,"sessionId" uuid,status text NOT NULL DEFAULT 'confirmed',error text,"errorCode" text,"createdAt" timestamptz NOT NULL DEFAULT now(),CONSTRAINT develop_batch_return_status_check CHECK(status IN ('confirmed','imported','completed','conflict','failed','cancelled')))`.execute(db);
  await sql`CREATE UNIQUE INDEX "IDX_develop_batch_return_itemId_checksum" ON develop_batch_return("itemId",checksum)`.execute(db);
  await sql`CREATE UNIQUE INDEX "IDX_develop_batch_return_revisionId" ON develop_batch_return("revisionId")`.execute(db);
  await sql`CREATE INDEX "IDX_develop_batch_return_pending" ON develop_batch_return("stagedAt") WHERE "pendingMasterPath" IS NOT NULL AND "revisionId" IS NULL`.execute(db);
  await sql`ALTER TABLE asset_develop_revision ADD COLUMN "batchChargedBytes" bigint NOT NULL DEFAULT 0`.execute(db);
}
export async function down(db:Kysely<any>):Promise<void>{await sql`ALTER TABLE asset_develop_revision DROP COLUMN "batchChargedBytes"`.execute(db);await sql`DROP TABLE develop_batch_return,develop_batch_item,develop_batch`.execute(db);}
