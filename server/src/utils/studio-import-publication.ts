import type { StudioProjectImport } from 'src/repositories/studio-project.repository.js';
import type { ProcessingProvenanceInput, RetainedProcessingProvenance } from 'src/utils/studio-import-provenance.js';
import type { StudioImportKind } from 'src/utils/studio-imports.js';

export type PublicationState = 'registered' | 'preparing' | 'published' | 'aborted';
export type PublicationKey = { ownerId: string; projectId: string; importId: string; publicationId: string };
export type FileIdentity = { dev: string; ino: string; size: number };
export type ImportDeclaration = {
  contentType: string;
  extension: string;
  sizeBytes: number;
  checksum: string;
  fileName: string;
  externalReferences: number | null;
  /** Null is normalized omission: ready retries preserve existing lineage; same-ID preparing retries still compare the full declaration. */
  processingProvenance: RetainedProcessingProvenance | null;
};
export type PreparedImport = {
  stagedPath: string;
  targetPath: string;
  identity: FileIdentity;
  declaration: ImportDeclaration;
};
export type PublicationRow = PublicationKey & {
  state: PublicationState;
  createdAt: Date;
  expiresAt: Date;
  file: PreparedImport | null;
};
export type PublishedImportReceipt = {
  id: string;
  kind: StudioImportKind;
  contentType: string;
  checksum: string;
  sizeBytes: number;
  fileName: string;
  externalReferences: number | null;
  createdAt: string;
  processingProvenance: RetainedProcessingProvenance | null;
};
export type PublicationReceipt = {
  publicationId: string;
  importId: string;
  state: PublicationState;
  createdAt: string;
  expiresAt: string;
  cleanupPending: boolean;
  imported?: PublishedImportReceipt;
};
export type ReceiptPage = { items: PublicationReceipt[]; nextCursor: string | null };
export type CancelResult = { status: 'cancelled' | 'already-published'; receipt: PublicationReceipt };
export interface FilePort {
  prepare(key: PublicationKey, incoming: string, declaration: ImportDeclaration): Promise<PreparedImport>;
  publish(file: PreparedImport): Promise<void>;
  release(file: PreparedImport, role: 'stage' | 'aborted'): Promise<void>;
}
export type PrepareResult =
  { status: 'prepared'; file: PreparedImport } | { status: 'ready'; imported: StudioProjectImport };
export type RawOptionalLineage = { publicationId?: unknown; processingProvenance?: unknown };
export interface JournalPort {
  register(key: PublicationKey): Promise<PublicationReceipt>;
  get(key: PublicationKey): Promise<PublicationReceipt | null>;
  discover(ownerId: string, projectId: string, cursor?: string, state?: PublicationState): Promise<ReceiptPage>;
  prepare(
    key: PublicationKey,
    file: PreparedImport,
    discardDuplicate: (file: PreparedImport) => Promise<void>,
  ): Promise<PrepareResult>;
  publish(key: PublicationKey, linkAndSync: (file: PreparedImport) => Promise<void>): Promise<StudioProjectImport>;
  cancel(key: PublicationKey): Promise<CancelResult>;
  release(
    key: PublicationKey,
    removeAndSync: (file: PreparedImport, role: 'stage' | 'aborted') => Promise<void>,
  ): Promise<void>;
}
export type RetentionUpload = { key: PublicationKey; incoming: string; declaration: ImportDeclaration };
export type OptionalLineage = { publicationId?: string; processingProvenance?: ProcessingProvenanceInput };
