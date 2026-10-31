export const tokenizeForSearch = (text: string) => [text];
export function vectorIndexQuery({
  table,
  indexName,
}: {
  vectorExtension?: string;
  table: string;
  indexName: string;
  lists?: number;
}) {
  return `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} USING hnsw (embedding vector_cosine_ops) WITH (ef_construction = 300, m = 16)`;
}
