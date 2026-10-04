export type ImportRow = Record<string, unknown>;
export interface ImportDatabase {
  query(sql: string, parameters?: unknown[]): Promise<ImportRow[]>;
  transaction<T>(body: (db: ImportDatabase) => Promise<T>): Promise<T>;
}
export type MediaRootMap = { source: string; target: string };
export type ImportConfig = {
  version: string;
  sourceId: string;
  writersStopped: boolean;
  mediaRoots: MediaRootMap[];
  // Exact model identifiers, not only vector dimensions. Omit to regenerate.
  embeddings?: { sourceClipModel: string; targetClipModel: string; sourceFaceModel: string; targetFaceModel: string };
};
export type TableShape = { columns: string[]; key: string[]; types: Record<string, string> };
export type FrozenSource = { commit: string; tables: Record<string, TableShape>; migrations: string[] };
export const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
export class ImportRefused extends Error {
  constructor(public readonly code: string) {
    super(`Immich import refused: ${code}`);
  }
}
