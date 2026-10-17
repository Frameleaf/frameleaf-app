import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql.raw("CREATE TABLE desktop_clip_index (scope text PRIMARY KEY, \"revisionId\" uuid NOT NULL, space jsonb,\n CONSTRAINT desktop_clip_index_scope_check CHECK (scope IN ('unadmitted','clip')),\n CONSTRAINT desktop_clip_index_space_check CHECK ((scope='unadmitted' AND space IS NULL) OR (scope='clip' AND space IS NOT NULL AND jsonb_typeof(space)='object')))").execute(db);
  await sql.raw("CREATE TABLE desktop_clip_producer (key text PRIMARY KEY, scope text NOT NULL DEFAULT 'unadmitted',\n CONSTRAINT desktop_clip_producer_scope_fkey FOREIGN KEY(scope) REFERENCES desktop_clip_index(scope) ON DELETE RESTRICT ON UPDATE RESTRICT,\n CONSTRAINT desktop_clip_producer_key_check CHECK (key='legacy' OR key ~ '^(image|text):clip:[a-f0-9]{64}$'))").execute(db);
  await sql.raw("INSERT INTO desktop_clip_index VALUES ('unadmitted',uuid_generate_v4(),NULL)").execute(db);
  await sql.raw("INSERT INTO desktop_clip_producer(key) VALUES ('legacy')").execute(db);
  await sql.raw("CREATE FUNCTION desktop_clip_producer_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$\n    DECLARE role text;\n    BEGIN\n      IF TG_TABLE_NAME = 'smart_search_description' THEN role := 'text';\n      ELSIF TG_TABLE_NAME IN ('smart_search', 'asset_video_duplicate_frame', 'video_moment_frame_embedding') THEN role := 'image';\n      ELSE RAISE EXCEPTION 'unsupported_clip_store';\n      END IF;\n      NEW.\"producerAdmissionKey\" := CASE WHEN NEW.\"producerModelKey\" IS NULL THEN 'legacy' ELSE role || ':' || NEW.\"producerModelKey\" END;\n      INSERT INTO public.desktop_clip_producer (key) VALUES (NEW.\"producerAdmissionKey\") ON CONFLICT DO NOTHING;\n      RETURN NEW;\n    END$guard$").execute(db);
  await sql.raw("ALTER TABLE \"smart_search\" ADD COLUMN \"producerAdmissionKey\" text NOT NULL DEFAULT 'legacy' ").execute(db);
  await sql.raw("INSERT INTO desktop_clip_producer(key) SELECT DISTINCT 'image:' || \"producerModelKey\" FROM \"smart_search\" WHERE \"producerModelKey\" IS NOT NULL ON CONFLICT DO NOTHING").execute(db);
  await sql.raw("UPDATE \"smart_search\" SET \"producerAdmissionKey\" = 'image:' || \"producerModelKey\" WHERE \"producerModelKey\" IS NOT NULL").execute(db);
  await sql.raw("ALTER TABLE \"smart_search\" ADD CONSTRAINT \"smart_search_producerAdmissionKey_fkey\" FOREIGN KEY(\"producerAdmissionKey\") REFERENCES desktop_clip_producer(key) ON DELETE RESTRICT ON UPDATE RESTRICT").execute(db);
  await sql.raw("CREATE TRIGGER \"smart_search_producer_guard\" BEFORE INSERT OR UPDATE ON \"smart_search\" FOR EACH ROW EXECUTE FUNCTION desktop_clip_producer_guard()").execute(db);
  await sql.raw("ALTER TABLE \"smart_search_description\" ADD COLUMN \"producerAdmissionKey\" text NOT NULL DEFAULT 'legacy' ").execute(db);
  await sql.raw("INSERT INTO desktop_clip_producer(key) SELECT DISTINCT 'text:' || \"producerModelKey\" FROM \"smart_search_description\" WHERE \"producerModelKey\" IS NOT NULL ON CONFLICT DO NOTHING").execute(db);
  await sql.raw("UPDATE \"smart_search_description\" SET \"producerAdmissionKey\" = 'text:' || \"producerModelKey\" WHERE \"producerModelKey\" IS NOT NULL").execute(db);
  await sql.raw("ALTER TABLE \"smart_search_description\" ADD CONSTRAINT \"smart_search_description_producerAdmissionKey_fkey\" FOREIGN KEY(\"producerAdmissionKey\") REFERENCES desktop_clip_producer(key) ON DELETE RESTRICT ON UPDATE RESTRICT").execute(db);
  await sql.raw("CREATE TRIGGER \"smart_search_description_producer_guard\" BEFORE INSERT OR UPDATE ON \"smart_search_description\" FOR EACH ROW EXECUTE FUNCTION desktop_clip_producer_guard()").execute(db);
  await sql.raw("ALTER TABLE \"asset_video_duplicate_frame\" ADD COLUMN \"producerAdmissionKey\" text NOT NULL DEFAULT 'legacy' ").execute(db);
  await sql.raw("INSERT INTO desktop_clip_producer(key) SELECT DISTINCT 'image:' || \"producerModelKey\" FROM \"asset_video_duplicate_frame\" WHERE \"producerModelKey\" IS NOT NULL ON CONFLICT DO NOTHING").execute(db);
  await sql.raw("DO $stamp$\nDECLARE original_mode \"char\";\nBEGIN\n  SELECT tgenabled INTO STRICT original_mode FROM pg_trigger\n    WHERE tgrelid = 'public.asset_video_duplicate_frame'::regclass AND tgname = 'asset_video_duplicate_frame_updatedAt';\n  ALTER TABLE public.asset_video_duplicate_frame DISABLE TRIGGER \"asset_video_duplicate_frame_updatedAt\";\n  UPDATE \"asset_video_duplicate_frame\" SET \"producerAdmissionKey\" = 'image:' || \"producerModelKey\" WHERE \"producerModelKey\" IS NOT NULL;\n  IF original_mode = 'O' THEN ALTER TABLE public.asset_video_duplicate_frame ENABLE TRIGGER \"asset_video_duplicate_frame_updatedAt\";\n  ELSIF original_mode = 'R' THEN ALTER TABLE public.asset_video_duplicate_frame ENABLE REPLICA TRIGGER \"asset_video_duplicate_frame_updatedAt\";\n  ELSIF original_mode = 'A' THEN ALTER TABLE public.asset_video_duplicate_frame ENABLE ALWAYS TRIGGER \"asset_video_duplicate_frame_updatedAt\";\n  END IF;\nEND $stamp$").execute(db);
  await sql.raw("ALTER TABLE \"asset_video_duplicate_frame\" ADD CONSTRAINT \"asset_video_duplicate_frame_producerAdmissionKey_fkey\" FOREIGN KEY(\"producerAdmissionKey\") REFERENCES desktop_clip_producer(key) ON DELETE RESTRICT ON UPDATE RESTRICT").execute(db);
  await sql.raw("CREATE TRIGGER \"asset_video_duplicate_frame_producer_guard\" BEFORE INSERT OR UPDATE ON \"asset_video_duplicate_frame\" FOR EACH ROW EXECUTE FUNCTION desktop_clip_producer_guard()").execute(db);
  await sql.raw("ALTER TABLE \"video_moment_frame_embedding\" ADD COLUMN \"producerAdmissionKey\" text NOT NULL DEFAULT 'legacy' ").execute(db);
  await sql.raw("INSERT INTO desktop_clip_producer(key) SELECT DISTINCT 'image:' || \"producerModelKey\" FROM \"video_moment_frame_embedding\" WHERE \"producerModelKey\" IS NOT NULL ON CONFLICT DO NOTHING").execute(db);
  await sql.raw("UPDATE \"video_moment_frame_embedding\" SET \"producerAdmissionKey\" = 'image:' || \"producerModelKey\" WHERE \"producerModelKey\" IS NOT NULL").execute(db);
  await sql.raw("ALTER TABLE \"video_moment_frame_embedding\" ADD CONSTRAINT \"video_moment_frame_embedding_producerAdmissionKey_fkey\" FOREIGN KEY(\"producerAdmissionKey\") REFERENCES desktop_clip_producer(key) ON DELETE RESTRICT ON UPDATE RESTRICT").execute(db);
  await sql.raw("CREATE TRIGGER \"video_moment_frame_embedding_producer_guard\" BEFORE INSERT OR UPDATE ON \"video_moment_frame_embedding\" FOR EACH ROW EXECUTE FUNCTION desktop_clip_producer_guard()").execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`LOCK TABLE desktop_clip_index IN ACCESS EXCLUSIVE MODE`.execute(db);
  const { rows } = await sql<{ active: boolean }>`SELECT EXISTS (SELECT 1 FROM desktop_clip_index WHERE scope = 'clip') AS active`.execute(db);
  if (rows[0].active) throw new Error('Cannot discard an admitted CLIP index during schema downgrade');
  await sql.raw('DROP TRIGGER "smart_search_producer_guard" ON "smart_search"').execute(db);
  await sql.raw('ALTER TABLE "smart_search" DROP COLUMN "producerAdmissionKey"').execute(db);
  await sql.raw('DROP TRIGGER "smart_search_description_producer_guard" ON "smart_search_description"').execute(db);
  await sql.raw('ALTER TABLE "smart_search_description" DROP COLUMN "producerAdmissionKey"').execute(db);
  await sql.raw('DROP TRIGGER "asset_video_duplicate_frame_producer_guard" ON "asset_video_duplicate_frame"').execute(db);
  await sql.raw('ALTER TABLE "asset_video_duplicate_frame" DROP COLUMN "producerAdmissionKey"').execute(db);
  await sql.raw('DROP TRIGGER "video_moment_frame_embedding_producer_guard" ON "video_moment_frame_embedding"').execute(db);
  await sql.raw('ALTER TABLE "video_moment_frame_embedding" DROP COLUMN "producerAdmissionKey"').execute(db);
  await sql`DROP FUNCTION desktop_clip_producer_guard()`.execute(db);
  await sql`DROP TABLE desktop_clip_producer`.execute(db);
  await sql`DROP TABLE desktop_clip_index`.execute(db);
}
