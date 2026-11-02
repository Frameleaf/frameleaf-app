export const LIBRARY_IMPORT_SCHEMA_SQL = `
CREATE TABLE public.frameleaf_library_import (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  operation_id uuid NOT NULL UNIQUE,
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
  status text NOT NULL CHECK (status IN ('copying','verifying','activated','abandoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (binding->>'operationId' IS NOT NULL AND binding->>'operationId' = operation_id::text)
);
CREATE TABLE public.frameleaf_library_import_mapping (
  operation_id uuid NOT NULL REFERENCES public.frameleaf_library_import(operation_id),
  entity_kind text NOT NULL CHECK (entity_kind IN ('owner','library','asset','file','album','person','stack')),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 1024),
  destination_id uuid NOT NULL,
  record_sha256 text NOT NULL CHECK (record_sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(operation_id,entity_kind,source_id)
);`;
