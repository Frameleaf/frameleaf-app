import { createHash } from 'node:crypto';
import { canonicalJson } from 'src/utils/object.js';

// OIDs, owners and sequence positions are installation-specific, not schema identity.
export const postgresSchemaQueries = {
  schemas: `SELECT nspname AS name FROM pg_catalog.pg_namespace
    WHERE nspname NOT IN ('pg_catalog','pg_toast','information_schema')
      AND nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%'
    ORDER BY nspname COLLATE "C"`,
  relations: `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
    c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security,
    c.relpersistence AS persistence, c.relispartition AS partition,
    pg_catalog.pg_get_expr(c.relpartbound,c.oid) AS partition_bound
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname COLLATE "C"`,
  columns: `SELECT c.relname AS table_name, a.attname AS name,
    pg_catalog.format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default, a.attidentity AS identity,
    a.attgenerated AS generated, col.collname AS collation,
    a.attinhcount::text AS inherited_count,a.attislocal AS local
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_collation col ON col.oid=a.attcollation
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
    ORDER BY c.relname COLLATE "C",a.attnum`,
  constraints: `SELECT c.relname AS table_name, p.conname AS name,
    p.contype AS type, p.convalidated AS validated,
    p.coninhcount::text AS inherited_count,p.conislocal AS local,p.connoinherit AS no_inherit,
    pg_catalog.pg_get_constraintdef(p.oid) AS definition
    FROM pg_catalog.pg_constraint p JOIN pg_catalog.pg_class c ON c.oid=p.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname COLLATE "C",p.conname COLLATE "C"`,
  inheritance: `SELECT child_ns.nspname AS child_schema,child.relname AS child,
    parent_ns.nspname AS parent_schema,parent.relname AS parent,i.inhseqno::text AS position
    FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class child ON child.oid=i.inhrelid
    JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid=child.relnamespace
    JOIN pg_catalog.pg_class parent ON parent.oid=i.inhparent
    JOIN pg_catalog.pg_namespace parent_ns ON parent_ns.oid=parent.relnamespace
    WHERE child_ns.nspname='public' OR parent_ns.nspname='public'
    ORDER BY child_ns.nspname COLLATE "C",child.relname COLLATE "C",i.inhseqno`,
  indexes: `SELECT c.relname AS table_name,i.relname AS name,
    p.indisvalid AS valid,p.indisready AS ready,pg_catalog.pg_get_indexdef(i.oid) AS definition
    FROM pg_catalog.pg_index p JOIN pg_catalog.pg_class i ON i.oid=p.indexrelid
    JOIN pg_catalog.pg_class c ON c.oid=p.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname COLLATE "C",i.relname COLLATE "C"`,
  sequences: `SELECT c.relname AS name,pg_catalog.format_type(s.seqtypid,NULL) AS type,
    s.seqstart::text AS start,s.seqincrement::text AS increment,s.seqmax::text AS maximum,
    s.seqmin::text AS minimum,s.seqcache::text AS cache,s.seqcycle AS cycle
    FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname COLLATE "C"`,
  enums: `SELECT t.typname AS name,e.enumlabel AS label,e.enumsortorder::text AS position
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    JOIN pg_catalog.pg_enum e ON e.enumtypid=t.oid
    WHERE n.nspname='public' ORDER BY t.typname COLLATE "C",e.enumsortorder`,
  types: `SELECT t.typname AS name,t.typtype AS kind,t.typcategory AS category,
    CASE WHEN t.typbasetype=0 THEN NULL ELSE pg_catalog.format_type(t.typbasetype,t.typtypmod) END AS base_type,
    CASE WHEN t.typelem=0 THEN NULL ELSE pg_catalog.format_type(t.typelem,NULL) END AS element_type,
    t.typnotnull AS not_null,t.typdefault AS default,c.relname AS relation
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    LEFT JOIN pg_catalog.pg_class c ON c.oid=t.typrelid
    WHERE n.nspname='public' ORDER BY t.typname COLLATE "C"`,
  routines: `SELECT p.proname AS name,p.prokind AS kind,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_catalog.format_type(p.prorettype,NULL) AS return_type,l.lanname AS language,
    p.prosrc AS source,p.probin AS binary,p.provolatile AS volatility,p.prosecdef AS security_definer,
    p.proconfig AS configuration
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE n.nspname='public' ORDER BY p.proname COLLATE "C",pg_catalog.pg_get_function_identity_arguments(p.oid) COLLATE "C"`,
  triggers: `SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled,
    pg_catalog.pg_get_triggerdef(t.oid) AS definition
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal
    ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C"`,
  policies: `SELECT schemaname AS schema,tablename AS table_name,policyname AS name,
    permissive,roles,cmd,qual,with_check FROM pg_catalog.pg_policies
    WHERE schemaname='public' ORDER BY tablename COLLATE "C",policyname COLLATE "C"`,
  views: `SELECT c.relname AS name,pg_catalog.pg_get_viewdef(c.oid) AS definition
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('v','m') ORDER BY c.relname COLLATE "C"`,
  extensions: `SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema
    FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
    ORDER BY e.extname COLLATE "C"`,
} as const;

export type PostgresSourceSchema = Record<keyof typeof postgresSchemaQueries, Record<string, unknown>[]>;

/** The caller holds one read-only transaction and fixes search_path and DateStyle before catalog access. */
export const readPostgresSourceSchema = async (
  query: (statement: string) => Promise<Record<string, unknown>[]>,
): Promise<PostgresSourceSchema> => {
  const entries = await Promise.all(
    Object.entries(postgresSchemaQueries).map(async ([name, statement]) => [name, await query(statement)]),
  );
  return Object.fromEntries(entries) as PostgresSourceSchema;
};

export const postgresSchemaFingerprint = (schema: PostgresSourceSchema): string =>
  createHash('sha256').update(canonicalJson(schema)).digest('hex');
