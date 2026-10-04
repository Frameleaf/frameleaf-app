import { normalizeBaselineDump, splitPostgresStatements } from 'src/schema/postgres-statements.js';

it('keeps SQL/PLpgSQL bodies and escaped string semicolons intact', () => {
  const statements = splitPostgresStatements(String.raw`-- heading
    CREATE FUNCTION f() RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN /* comment; */ RETURN 'a;b'; END; $body$;
    SELECT E'a\';b', 'a'';b', "semi;colon"; /* outer /* nested */ comment */`);
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain("RETURN 'a;b'; END; $body$;");
  expect(statements[1]).toContain("'a'';b'");
});

it('removes dump client controls and only the provider-owned ledger tables', () => {
  const dump = String.raw`-- Dumped from database version 19beta4
\restrict abc123
SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE TABLE public.frameleaf_migrations (name text);
ALTER TABLE ONLY public.frameleaf_migrations ADD CONSTRAINT frameleaf_migrations_pkey PRIMARY KEY (name);
CREATE TABLE public.job_selection (id uuid NOT NULL);
CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END; $$;
\unrestrict abc123
`;
  const sql = normalizeBaselineDump(dump);
  expect(sql).not.toContain('frameleaf_migrations');
  expect(sql).not.toContain(String.raw`\restrict`);
  expect(sql).toContain('CREATE TABLE public.job_selection');
  expect(splitPostgresStatements(sql)).toHaveLength(5);
});

it.each(["SELECT 'unterminated;", 'SELECT $body$unfinished;', 'SELECT 1 /* unterminated', 'SELECT 1'])(
  'rejects truncated SQL: %s',
  (sql) => {
    expect(() => splitPostgresStatements(sql)).toThrow('Unterminated');
  },
);

it('rejects unexpected dump commands instead of executing data or psql shell commands', () => {
  expect(() => normalizeBaselineDump('-- Dumped from database version 19\nINSERT INTO x VALUES (1);')).toThrow(
    'non-schema',
  );
  expect(() =>
    splitPostgresStatements(String.raw`\! arbitrary-command
`),
  ).toThrow('psql commands');
});
