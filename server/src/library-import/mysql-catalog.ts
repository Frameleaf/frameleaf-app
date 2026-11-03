const catalogs = [
  {
    name: 'tables',
    table: 'TABLES',
    scope: 'TABLE_SCHEMA',
    columns: ['TABLE_NAME', 'TABLE_TYPE', 'ENGINE', 'TABLE_COLLATION', 'CREATE_OPTIONS'],
  },
  {
    name: 'columns',
    table: 'COLUMNS',
    scope: 'TABLE_SCHEMA',
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
    columns: ['TABLE_NAME', 'CONSTRAINT_NAME', 'CONSTRAINT_TYPE'],
  },
  {
    name: 'keys',
    table: 'KEY_COLUMN_USAGE',
    scope: 'TABLE_SCHEMA',
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
    columns: ['TRIGGER_NAME', 'EVENT_MANIPULATION', 'EVENT_OBJECT_TABLE', 'ACTION_STATEMENT', 'ACTION_TIMING'],
  },
  {
    name: 'routines',
    table: 'ROUTINES',
    scope: 'ROUTINE_SCHEMA',
    columns: ['ROUTINE_NAME', 'ROUTINE_TYPE', 'ROUTINE_DEFINITION'],
  },
  {
    name: 'events',
    table: 'EVENTS',
    scope: 'EVENT_SCHEMA',
    columns: ['EVENT_NAME', 'EVENT_DEFINITION', 'STATUS'],
  },
] as const;

const mysqlCatalogs = [
  ...catalogs.map((catalog) => ({
    ...catalog,
    columns:
      catalog.name === 'indexes'
        ? [...catalog.columns.filter((column) => column !== 'IGNORED'), 'IS_VISIBLE', 'EXPRESSION']
        : catalog.name === 'constraints'
          ? [...catalog.columns, 'ENFORCED']
          : catalog.columns,
  })),
  {
    name: 'foreignKeys',
    table: 'REFERENTIAL_CONSTRAINTS',
    scope: 'CONSTRAINT_SCHEMA',
    columns: [
      'TABLE_NAME',
      'CONSTRAINT_NAME',
      'REFERENCED_TABLE_NAME',
      'UPDATE_RULE',
      'DELETE_RULE',
      'MATCH_OPTION',
      'UNIQUE_CONSTRAINT_NAME',
    ],
  },
  {
    name: 'checks',
    table: 'CHECK_CONSTRAINTS',
    scope: 'CONSTRAINT_SCHEMA',
    columns: ['CONSTRAINT_NAME', 'CHECK_CLAUSE'],
  },
];

/** Caller keeps the isolated restore locked; incomplete metadata visibility must be refused before collection. */
export const readMysqlSourceSchema = async (
  query: (statement: string, parameters: string[]) => Promise<Record<string, unknown>[]>,
  engine: 'mariadb' | 'mysql' = 'mariadb',
): Promise<Record<string, unknown>> => {
  const result: Record<string, unknown> = {};
  for (const catalog of engine === 'mysql' ? mysqlCatalogs : catalogs) {
    const fields = catalog.columns.map((column) => `'${column}',\`${column}\``).join(',');
    const referenceSchema =
      engine !== 'mysql'
        ? undefined
        : catalog.name === 'keys'
          ? 'REFERENCED_TABLE_SCHEMA'
          : catalog.name === 'foreignKeys'
            ? 'UNIQUE_CONSTRAINT_SCHEMA'
            : undefined;
    // Database names vary; an external reference must never fingerprint as a source-local relationship.
    const namespace = referenceSchema
      ? `,'${referenceSchema}',IF(\`${referenceSchema}\` IS NULL,NULL,IF(CAST(\`${referenceSchema}\` AS BINARY)=CAST(DATABASE() AS BINARY),'source','external'))`
      : '';
    const scope =
      engine === 'mysql'
        ? `CAST(\`${catalog.scope}\` AS BINARY)=CAST(DATABASE() AS BINARY)`
        : `\`${catalog.scope}\`=DATABASE()`;
    const rows = await query(
      `SELECT JSON_ARRAYAGG(JSON_OBJECT(${fields}${namespace})) AS records FROM information_schema.${catalog.table} WHERE ${scope}`,
      [],
    );
    if (rows.length !== 1) throw new Error('MySQL schema refused: MYSQL_CATALOG_INVALID');
    const value = rows[0].records;
    result[catalog.name] = value === null ? [] : typeof value === 'string' ? JSON.parse(value) : value;
  }
  return result;
};
