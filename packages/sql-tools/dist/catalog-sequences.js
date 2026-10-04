const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const qualified = (name) => `"public".${quote(name)}`;
const configuration = (sequence) => {
  if (!['smallint', 'integer', 'bigint'].includes(sequence.dataType)) throw new Error('Invalid sequence data type');
  for (const field of ['start', 'min', 'max', 'increment', 'cache']) {
    if (!/^-?\d+$/.test(sequence[field])) throw new Error(`Invalid sequence ${field}`);
  }
  return `AS ${sequence.dataType} INCREMENT BY ${sequence.increment} MINVALUE ${sequence.min} MAXVALUE ${sequence.max} START WITH ${sequence.start} CACHE ${sequence.cache} ${sequence.cycle ? 'CYCLE' : 'NO CYCLE'}`;
};

export const sequenceDiffSql = ({ type, object }) => {
  switch (type) {
    case 'SequenceCreate': return `CREATE SEQUENCE ${qualified(object.name)} ${configuration(object)};`;
    case 'SequenceAlter': return `ALTER SEQUENCE ${qualified(object.name)} ${configuration(object)};`;
    case 'SequenceDrop': return `DROP SEQUENCE IF EXISTS ${qualified(object.name)};`;
    case 'SequenceOwnership': return `ALTER SEQUENCE ${qualified(object.name)} OWNED BY ${object.owner ? `${qualified(object.owner.tableName)}.${quote(object.owner.columnName)}` : 'NONE'};`;
  }
};

/** Owned sequences are created before defaults, ownership after tables; identity columns create their own sequence. */
export const sequenceDiff = (source, target, tableChanges) => {
  if (source === undefined) return { before: [], after: [] };
  const before = [];
  const after = [];
  const add = (items, type, object) => items.push({ type, object, reason: 'sequence schema changed' });
  const config = ({ dataType, start, min, max, increment, cache, cycle }) => JSON.stringify({ dataType, start, min, max, increment, cache, cycle });
  for (const desired of source) {
    const existing = (target ?? []).find(({ name }) => name === desired.name);
    if (!existing) {
      if (desired.identity) {
        // The missing identity column/table creates the sequence. Apply nondefault options afterwards.
        add(after, 'SequenceAlter', desired);
      } else {
        add(before, 'SequenceCreate', desired);
        if (desired.owner) add(after, 'SequenceOwnership', desired);
      }
    } else {
      if (config(desired) !== config(existing)) add(after, 'SequenceAlter', desired);
      if (!desired.identity && JSON.stringify(desired.owner) !== JSON.stringify(existing.owner)) add(after, 'SequenceOwnership', desired);
    }
  }
  for (const existing of target ?? []) {
    if (source.some(({ name }) => name === existing.name)) continue;
    // PostgreSQL removes owned sequences with their dropped table/column.
    const removedWithOwner = existing.owner && tableChanges.some(({ type, object }) =>
      (type === 'TableDrop' && object.name === existing.owner.tableName) ||
      (type === 'ColumnDrop' && object.tableName === existing.owner.tableName && object.name === existing.owner.columnName));
    if (!removedWithOwner) add(after, 'SequenceDrop', existing);
  }
  return { before, after };
};
