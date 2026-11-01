const catalogs = [
  {
    name: 'tables',
    table: 'TABLES',
    scope: 'TABLE_SCHEMA',
    namespace: 'TABLE_NAME',
    columns: ['TABLE_NAME', 'TABLE_TYPE', 'ENGINE', 'TABLE_COLLATION', 'CREATE_OPTIONS'],
  },
  {
    name: 'columns',
    table: 'COLUMNS',
    scope: 'TABLE_SCHEMA',
    namespace: 'TABLE_NAME',
    columns: [
      'TABLE_NAME',
      'COLUMN_NAME',
      'ORDINAL_POSITION',
      'COLUMN_TYPE',
      'IS_NULLABLE',
      'COLUMN_DEFAULT',
      'EXTRA',
      'CHARACTER_SET_NAME',
      'COLLATION_NAME',
      'GENERATION_EXPRESSION',
    ],
  },
  {
    name: 'indexes',
    table: 'STATISTICS',
    scope: 'TABLE_SCHEMA',
    namespace: 'TABLE_NAME',
    columns: [
      'TABLE_NAME',
      'INDEX_NAME',
      'NON_UNIQUE',
      'SEQ_IN_INDEX',
      'COLUMN_NAME',
      'COLLATION',
      'SUB_PART',
      'NULLABLE',
      'INDEX_TYPE',
      'IGNORED',
    ],
  },
  {
    name: 'constraints',
    table: 'TABLE_CONSTRAINTS',
    scope: 'TABLE_SCHEMA',
    namespace: 'TABLE_NAME',
    columns: ['TABLE_NAME', 'CONSTRAINT_NAME', 'CONSTRAINT_TYPE'],
  },
  {
    name: 'keys',
    table: 'KEY_COLUMN_USAGE',
    scope: 'TABLE_SCHEMA',
    namespace: 'TABLE_NAME',
    columns: [
      'TABLE_NAME',
      'CONSTRAINT_NAME',
      'COLUMN_NAME',
      'ORDINAL_POSITION',
      'REFERENCED_TABLE_NAME',
      'REFERENCED_COLUMN_NAME',
    ],
  },
  {
    name: 'triggers',
    table: 'TRIGGERS',
    scope: 'TRIGGER_SCHEMA',
    namespace: 'EVENT_OBJECT_TABLE',
    columns: ['TRIGGER_NAME', 'EVENT_MANIPULATION', 'EVENT_OBJECT_TABLE', 'ACTION_STATEMENT', 'ACTION_TIMING'],
  },
  {
    name: 'routines',
    table: 'ROUTINES',
    scope: 'ROUTINE_SCHEMA',
    namespace: null,
    columns: ['ROUTINE_NAME', 'ROUTINE_TYPE', 'ROUTINE_DEFINITION'],
  },
  {
    name: 'events',
    table: 'EVENTS',
    scope: 'EVENT_SCHEMA',
    namespace: null,
    columns: ['EVENT_NAME', 'EVENT_DEFINITION', 'STATUS'],
  },
] as const;

/** Caller keeps the isolated restore locked; incomplete metadata visibility must be refused before collection. */
export const readMysqlSourceSchema = async (
  query: (statement: string, parameters: string[]) => Promise<Record<string, unknown>[]>,
  prefix: string,
): Promise<Record<string, unknown>> => {
  const result: Record<string, unknown> = {};
  for (const catalog of catalogs) {
    const fields = catalog.columns.map((column) => `'${column}',\`${column}\``).join(',');
    const where = catalog.namespace ? ` AND LEFT(\`${catalog.namespace}\`,CHAR_LENGTH(?))=?` : '';
    const rows = await query(
      `SELECT JSON_ARRAYAGG(JSON_OBJECT(${fields})) AS records FROM information_schema.${catalog.table} WHERE \`${catalog.scope}\`=DATABASE()${where}`,
      catalog.namespace ? [prefix, prefix] : [],
    );
    if (rows.length !== 1) throw new Error('MySQL schema refused: MYSQL_CATALOG_INVALID');
    const value = rows[0].records;
    result[catalog.name] = value === null ? [] : typeof value === 'string' ? JSON.parse(value) : value;
  }
  return result;
};
