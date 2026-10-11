import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE public.landmark (
    id character varying(20) NOT NULL, name text NOT NULL, names jsonb DEFAULT '{}'::jsonb NOT NULL,
    kind character varying(20) NOT NULL, latitude double precision NOT NULL, longitude double precision NOT NULL,
    "radiusM" integer NOT NULL, rank integer NOT NULL, CONSTRAINT landmark_pkey PRIMARY KEY (id)
  )`.execute(db);
  await sql`CREATE INDEX landmark_gist_earthcoord_idx ON public.landmark
    USING gist (public.ll_to_earth_public(latitude, longitude))`.execute(db);
  await sql`CREATE TABLE public.landmark_area (
    id integer GENERATED ALWAYS AS IDENTITY NOT NULL, "landmarkId" character varying(20) NOT NULL,
    area polygon NOT NULL, CONSTRAINT landmark_area_pkey PRIMARY KEY (id)
  )`.execute(db);
  await sql`CREATE INDEX "landmark_area_landmarkId_idx" ON public.landmark_area ("landmarkId")`.execute(db);
  await sql`CREATE TABLE public.asset_landmark (
    "assetId" uuid NOT NULL REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE,
    "landmarkId" character varying(20) NOT NULL, CONSTRAINT asset_landmark_pkey PRIMARY KEY ("assetId", "landmarkId")
  )`.execute(db);
  await sql`CREATE INDEX "asset_landmark_landmarkId_idx" ON public.asset_landmark ("landmarkId")`.execute(db);
  await sql`CREATE FUNCTION public.asset_exif_landmark_match() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.latitude IS NOT DISTINCT FROM NEW.latitude
        AND OLD.longitude IS NOT DISTINCT FROM NEW.longitude THEN
        RETURN NULL;
      END IF;
      DELETE FROM public.asset_landmark WHERE "assetId" = NEW."assetId";
      IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
        INSERT INTO public.asset_landmark ("assetId", "landmarkId")
        SELECT NEW."assetId", l.id
        FROM public.landmark l
        WHERE public.earth_box(public.ll_to_earth_public(NEW.latitude, NEW.longitude), 200000)
            OPERATOR(public.@>) public.ll_to_earth_public(l.latitude, l.longitude)
          AND public.earth_distance(
            public.ll_to_earth_public(NEW.latitude, NEW.longitude),
            public.ll_to_earth_public(l.latitude, l.longitude)) <= l."radiusM"
          AND (NOT EXISTS (SELECT FROM public.landmark_area a WHERE a."landmarkId" = l.id)
            OR EXISTS (SELECT FROM public.landmark_area a
              WHERE a."landmarkId" = l.id AND a.area @> point(NEW.longitude, NEW.latitude)))
        ON CONFLICT DO NOTHING;
      END IF;
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'asset_exif_landmark_match: %', SQLERRM;
      RETURN NULL;
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER asset_exif_landmark_match_insert AFTER INSERT ON public.asset_exif FOR EACH ROW
    EXECUTE FUNCTION public.asset_exif_landmark_match()`.execute(db);
  await sql`CREATE TRIGGER asset_exif_landmark_match_update AFTER UPDATE ON public.asset_exif FOR EACH ROW
    EXECUTE FUNCTION public.asset_exif_landmark_match()`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER asset_exif_landmark_match_update ON public.asset_exif`.execute(db);
  await sql`DROP TRIGGER asset_exif_landmark_match_insert ON public.asset_exif`.execute(db);
  await sql`DROP FUNCTION public.asset_exif_landmark_match()`.execute(db);
  await sql`DROP TABLE public.asset_landmark, public.landmark_area, public.landmark`.execute(db);
}
