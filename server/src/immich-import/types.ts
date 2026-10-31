import type { DatabaseSchema } from '@frameleaf/sql-tools';
import type { SourceStructure } from 'src/immich-import/schema.js';

export type ImportRow = Record<string, unknown>;
export interface ImportDatabase {
  query(sql: string, parameters?: unknown[]): Promise<ImportRow[]>;
  transaction<T>(body: (db: ImportDatabase) => Promise<T>): Promise<T>;
  /** Destination-only introspection, bound to the same URL as query/transaction. */
  readSchema?(): Promise<DatabaseSchema>;
}
export type MediaRootMap = { source: string; target: string };
export type ImportMediaPolicy =
  | { mode: 'independent-copy' }
  | { mode: 'manager-in-place'; authority: 'frameleaf-manager'; operationId: string; deploymentId: string };
export type ImportConfig = {
  version: string;
  sourceId: string;
  writersStopped: boolean;
  mediaRoots: MediaRootMap[];
  media?: ImportMediaPolicy;
  // Retained for configuration compatibility only. Operator claims never authorize embedding transfer.
  embeddings?: { sourceClipModel: string; targetClipModel: string; sourceFaceModel: string; targetFaceModel: string };
};
export type TableShape = { columns: string[]; key: string[]; types: Record<string, string> };
export type FrozenSource = {
  commit: string;
  structure: SourceStructure;
  tables: Record<string, TableShape>;
  migrations: string[];
  /** Read-only SELECTs that present older releases' rows in the 3.0.0 shape, by table. */
  views: Record<string, string>;
  /** Pinned catalogs are compared exactly; replayed 2.x catalogs only by the columns the importer reads. */
  exact: boolean;
};
export const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
export class ImportRefused extends Error {
  constructor(public readonly code: string) {
    super(`Immich import refused: ${code}`);
  }
}
