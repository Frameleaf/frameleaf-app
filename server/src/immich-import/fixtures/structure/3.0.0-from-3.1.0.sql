-- Reverse the only table-shape change between pinned 3.0.x and 3.1.0.
ALTER TABLE public.session DROP COLUMN "oauthBearerToken";
