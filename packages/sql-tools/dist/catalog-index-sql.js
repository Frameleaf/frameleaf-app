// PostgreSQL folds a restored varchar[] -> text[] cast into casts on each literal.
// Compare those two deparser forms equally, without rewriting quoted SQL text.
// PostgreSQL 19.0 prints date_trunc(...) AT TIME ZONE index expressions with one more pair of
// parentheses than 19 RC 1 did. Compare both forms equally.
// Other casts and expression changes deliberately retain exact comparison.
const literal = String.raw`'(?:[^']|'')*'::character varying`;
const zoned = String.raw`date_trunc\('[A-Za-z]+'::text, \("(?:[^"]|"")+" AT TIME ZONE '[^']*'::text\)\) AT TIME ZONE '[^']*'::text`;
const sqlParts = new RegExp(
  String.raw`[Ee]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|(?<quote>\$(?:[A-Za-z_\u0080-\u{10ffff}][A-Za-z_0-9\u0080-\u{10ffff}]*)?\$)[\s\S]*?\k<quote>|/\*[\s\S]*?\*/|--[^\n]*(?:\n|$)|\(ARRAY\[(?<elements>${literal}(?:, ${literal})*)\]\)::text\[\]|\(\((?<zoned>${zoned})\)\)`,
  'gu',
);
const literals = new RegExp(literal, 'gu');

const normalizeOnce = (value) =>
  value.replace(sqlParts, (match, ...args) => {
    const { elements, zoned } = args.at(-1);
    if (zoned !== undefined) {
      return `(${zoned})`;
    }
    return elements === undefined ? match : `ARRAY[${elements.replace(literals, '($&)::text')}]`;
  });

export function normalizeIndexSql(value) {
  // Repeat until stable: a sole index expression carries its own extra pair, "(((...)))" against "((...))".
  for (let next; value !== undefined && (next = normalizeOnce(value)) !== value; value = next);
  return value;
}
