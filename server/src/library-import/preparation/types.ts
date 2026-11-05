import { type ImportManifest, type SourceKind } from 'src/library-import/manifest.js';
import { type ImportedPassword, type ImportedPasswordContext } from 'src/library-import/passwords.js';

/** Where the Manager placed the frozen source inside the offline preparation container. */
export type PreparationSourceInput = {
  source: ImportManifest['source'];
  /** SQLite snapshot captured while the source writers were fenced. */
  snapshotPath?: string;
  /** Restored copy of the source database on the preparation's isolated network. */
  databaseUrl?: string;
  /** Read-only mount of the source originals. File paths are relative to it. */
  originalsRoot: string;
};

/** Source login facts. Unknown facts must be reported as restrictive, never permissive. */
export type SourceLogin = {
  accountEnabled: boolean;
  passwordLoginEnabled: boolean;
  secondFactorRequired: boolean;
  externalIdentityRequired: boolean;
  ownedLibraryAccess: 'full' | 'restricted' | 'none';
  otherRestrictions: 'none' | 'present';
};

export type PreparationOwner = {
  sourceId: string;
  name: string;
  email: string | null;
  login: SourceLogin;
  /** A portable verifier, or undefined when the account must be claimed through an emailed link. */
  password(context: ImportedPasswordContext): Promise<ImportedPassword | undefined>;
};

/** One original/companion/sidecar the manifest references, relative to `originalsRoot`. */
export type PreparationFile = { id: string; path: string; role: ImportManifest['files'][number]['role'] };

export type ObservedFile = ImportManifest['files'][number] & { modifiedAt: string };

export type OpenedPreparationSource = {
  /** True when version and schema match a qualified fixture; false means best effort. */
  tested: boolean;
  /** Version the reader was qualified against, shown as the suggested upgrade target. */
  testedVersion: string;
  owners(): Promise<PreparationOwner[]>;
  files(): Promise<PreparationFile[]>;
  manifest(
    files: ObservedFile[],
  ): Promise<{ manifest: ImportManifest; archive: Iterable<unknown> | AsyncIterable<unknown> }>;
  close(): Promise<void> | void;
};

export type PreparationAdapter = {
  kind: SourceKind;
  /**
   * How the Manager can deliver the frozen database: a SQLite snapshot file, or a restored copy reachable on
   * 127.0.0.1 (the preparation shares the restore container's network namespace; neither has another network).
   */
  databases: ('sqlite' | 'mysql' | 'postgres')[];
  open(input: PreparationSourceInput): Promise<OpenedPreparationSource>;
};

/** Every login fact permissive: only for sources whose accounts have no such restrictions. */
export const unrestrictedLogin: SourceLogin = {
  accountEnabled: true,
  passwordLoginEnabled: true,
  secondFactorRequired: false,
  externalIdentityRequired: false,
  ownedLibraryAccess: 'full',
  otherRestrictions: 'none',
};

/** Readers refuse unknown versions with `<SOURCE>_VERSION_UNQUALIFIED` / `_SCHEMA_UNQUALIFIED`. */
export const isQualificationRefusal = (error: unknown) =>
  error instanceof Error && /_(VERSION|SCHEMA|MIGRATIONS|APPLICATION_STATE)_UNQUALIFIED\b/u.test(error.message);
