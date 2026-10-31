/** Split pg_dump SQL without splitting function bodies, quoted identifiers or string literals. */
export const splitPostgresStatements = (input: string): string[] => {
  const statements: string[] = [];
  let current = '';
  let quote = '';
  let dollar = '';
  let escapedString = false;
  let commentDepth = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];
    if (commentDepth) {
      if (char === '/' && next === '*') {
        commentDepth++;
        i++;
      } else if (char === '*' && next === '/') {
        commentDepth--;
        i++;
      }
      continue;
    }
    if (dollar) {
      if (input.startsWith(dollar, i)) {
        current += dollar;
        i += dollar.length - 1;
        dollar = '';
      } else current += char;
      continue;
    }
    if (quote) {
      current += char;
      if (escapedString && char === '\\') current += input[++i] ?? '';
      else if (char === quote) {
        if (next === quote) current += input[++i];
        else quote = '';
      }
      continue;
    }
    if (char === '-' && next === '-') {
      while (i < input.length && input[i] !== '\n') i++;
      current += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      commentDepth = 1;
      i++;
      current += ' ';
      continue;
    }
    if (char === '\\') throw new Error('psql commands are not executable migration SQL');
    switch (char) {
      case "'":
      case '"': {
        quote = char;
        escapedString = char === "'" && /(?:^|\W)[eE]$/u.test(current);
        break;
      }
      case '$': {
        const tag = input.slice(i).match(/^\$(?:[A-Za-z_]\w*)?\$/u)?.[0];
        if (tag) {
          dollar = tag;
          current += tag;
          i += tag.length - 1;
          continue;
        }
        break;
      }
      case ';': {
        if (current.trim()) statements.push(current.trim() + ';');
        current = '';
        continue;
      }
    }
    current += char;
  }
  if (quote || dollar || commentDepth) throw new Error('Unterminated PostgreSQL SQL token');
  if (current.trim()) throw new Error('Unterminated PostgreSQL statement');
  return statements;
};

/** Convert only a schema-only pg_dump; provider ledger tables remain owned by Kysely. */
export const normalizeBaselineDump = (dump: string): string => {
  if (!dump.includes('-- Dumped from database version 19')) throw new Error('Baseline capture requires PostgreSQL 19');
  // pg_dump emits these client controls before/after all SQL, never inside a statement.
  const restricted = dump.replace(/^\\restrict [A-Za-z0-9]+\r?\n/mu, '');
  const unrestricted = restricted.replace(/^\\unrestrict [A-Za-z0-9]+\r?\n(?=\s*$)/mu, '');
  const statements = splitPostgresStatements(unrestricted).filter((statement) => {
    if (
      /^SET (?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout|client_encoding|standard_conforming_strings|check_function_bodies|xmloption|client_min_messages|row_security|default_tablespace|default_table_access_method) = /u.test(
        statement,
      )
    )
      return false;
    if (statement === "SELECT pg_catalog.set_config('search_path', '', false);") return false;
    if (/^(?:CREATE TABLE|ALTER TABLE(?: ONLY)?) public\.frameleaf_migrations(?:_lock)?\b/u.test(statement))
      return false;
    if (/\bframeleaf_migrations(?:_lock)?\b/u.test(statement))
      throw new Error('Unrecognized migration ledger DDL in capture');
    if (!/^(?:CREATE|ALTER|COMMENT ON) /u.test(statement))
      throw new Error('Unexpected non-schema statement in pg_dump');
    return true;
  });
  return (
    'SET LOCAL standard_conforming_strings = on;\nSET LOCAL check_function_bodies = false;\nSET LOCAL search_path = public, pg_catalog;\n\n' +
    statements.join('\n\n') +
    '\n'
  );
};
