// PostgreSQL folds a restored varchar[] -> text[] cast into casts on each literal.
// Compare those two deparser forms equally, without rewriting quoted SQL text.
// Other casts and expression changes deliberately retain exact comparison.
const literal = String.raw`'(?:[^']|'')*'::character varying`;
const sqlParts = new RegExp(
  String.raw`[Ee]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|(?<quote>\$(?:[A-Za-z_\u0080-\u{10ffff}][A-Za-z_0-9\u0080-\u{10ffff}]*)?\$)[\s\S]*?\k<quote>|/\*[\s\S]*?\*/|--[^\n]*(?:\n|$)|\(ARRAY\[(?<elements>${literal}(?:, ${literal})*)\]\)::text\[\]`,
  'gu',
);
const literals = new RegExp(literal, 'gu');

export function normalizeIndexSql(value) {
  return value?.replace(sqlParts, (match, ...args) => {
    const { elements } = args.at(-1);
    return elements === undefined ? match : `ARRAY[${elements.replace(literals, '($&)::text')}]`;
  });
}
