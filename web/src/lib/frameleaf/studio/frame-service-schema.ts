import type { StudioSourceResolutionRequestDto, StudioSourceResolutionDto } from '@frameleaf/sdk';
import type { StudioCommandEnvelope, StudioCommandResult } from './commands';
import {
  isStudioProjectImportUpload,
  isStudioPublicationId,
  isStudioEditorScope as isPublicationEditorScope,
} from './frame-protocol';
import type {
  StudioCancelResult,
  StudioDraftResult,
  StudioEditorScope,
  StudioEditorCommitResult,
  StudioAssetRef,
  StudioLibraryFacets,
  StudioLibraryQuery,
  StudioLibraryResults,
  StudioLibraryType,
  StudioProjectHandle,
  StudioProjectImportUpload,
  StudioProjectImportRef,
  StudioWorkspaceSaveResult,
} from './host-contract';

/** Services the frame may call. Each maps one-to-one onto `StudioHostServices`. */
interface StudioFrameServiceCallsV7 {
  submitCommands: { args: [envelopes: StudioCommandEnvelope[]]; result: StudioCommandResult[] };
  stageDraft: {
    args: [graph: unknown, commandIds: string[], baseRevision?: number, graphVersion?: number];
    result: StudioDraftResult;
  };
  commitEditorDraft: {
    args: [graph: unknown, baseRevision: number, scope: StudioEditorScope];
    result: { status: 'saved'; revision: number } | { status: 'rejected'; reason: string };
  };
  reloadProject: { args: []; result: Omit<StudioProjectHandle, 'graphDigest' | 'leaseEpoch' | 'leaseExpiresAt'> };
  authorizeGeneratedMedia: { args: []; result: boolean };
  saveWorkspace: { args: [layout: unknown]; result: StudioWorkspaceSaveResult };
  /** Protocol 5 (FL-103 / FL-105): keep a file imported in the editor with the project. */
  uploadProjectImport: { args: [upload: StudioProjectImportUpload]; result: StudioProjectImportRef };
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const authoredId = (value: unknown) =>
  value === undefined || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value));
export const isStudioEditorScope = (value: unknown): value is StudioEditorScope =>
  record(value) &&
  exact(value, ['projectId', 'userId', 'graphVersion']) &&
  typeof value.projectId === 'string' &&
  typeof value.userId === 'string' &&
  count(value.graphVersion);
export const isStudioSourceRequest = (value: unknown): value is StudioSourceResolutionRequestDto => {
  if (
    !record(value) ||
    !exact(value, ['revision', 'graphDigest', 'parent', 'selection']) ||
    !count(value.revision) ||
    (value.revision as number) < 1 ||
    !digest(value.graphDigest) ||
    !record(value.parent) ||
    !record(value.selection)
  ) {
    return false;
  }
  const { parent, selection } = value;
  return (
    exact(parent, ['kind', 'id', 'checksum']) &&
    (parent.kind === 'project-import' || parent.kind === 'vector-graphic') &&
    id(parent.id) &&
    digest(parent.checksum) &&
    exact(selection, ['animationId', 'themeId']) &&
    authoredId(selection.animationId) &&
    authoredId(selection.themeId)
  );
};

const LIBRARY_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LIBRARY_TYPES: ReadonlySet<StudioLibraryType> = new Set(['all', 'photo', 'video']);
/** The most ids one `addLibraryAssets` call may name: a multi-select drag, not the whole library. */
export const STUDIO_LIBRARY_ADD_LIMIT = 50;
/** The longest search text the host accepts; the Library view's box stops typing there. */
export const STUDIO_LIBRARY_TEXT_LIMIT = 500;
/** The last results page the frame may ask for; the host never offers a page after it. */
export const STUDIO_LIBRARY_PAGE_LIMIT = 1000;

/**
 * Whether a Library view query from the frame has the shape the host accepts (FL-636). The frame is
 * not trusted: unknown keys, a malformed month or person id, or an oversized text is refused before
 * any search runs.
 */
export const isStudioLibraryQuery = (value: unknown): value is StudioLibraryQuery => {
  if (!record(value) || !exact(value, ['text', 'type', 'personId', 'city', 'month', 'page'])) {
    return false;
  }
  const text = (field: unknown, max: number) =>
    field === undefined || field === null || (typeof field === 'string' && field.length <= max);
  const absent = (field: unknown) => field === undefined || field === null;
  return (
    text(value.text, STUDIO_LIBRARY_TEXT_LIMIT) &&
    (value.type === undefined || LIBRARY_TYPES.has(value.type as StudioLibraryType)) &&
    (absent(value.personId) || id(value.personId)) &&
    text(value.city, 200) &&
    (absent(value.month) || (typeof value.month === 'string' && LIBRARY_MONTH.test(value.month))) &&
    (value.page === undefined ||
      (count(value.page) && (value.page as number) >= 1 && (value.page as number) <= STUDIO_LIBRARY_PAGE_LIMIT))
  );
};
export const isStudioLibraryAssetIds = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= STUDIO_LIBRARY_ADD_LIMIT &&
  value.every((item) => id(item));

/** Frozen names and tuple/result contract for peers built before closed source ownership. */
export const STUDIO_FRAME_SERVICE_SCHEMA_V7 = Object.freeze({
  submitCommands: (args: unknown[]) => args.length === 1 && Array.isArray(args[0]),
  stageDraft: (args: unknown[]) => args.length >= 2 && args.length <= 4 && Array.isArray(args[1]),
  commitEditorDraft: (args: unknown[]) => args.length === 3 && count(args[1]) && isStudioEditorScope(args[2]),
  reloadProject: (args: unknown[]) => args.length === 0,
  authorizeGeneratedMedia: (args: unknown[]) => args.length === 0,
  saveWorkspace: (args: unknown[]) => args.length === 1,
  uploadProjectImport: (args: unknown[]) => args.length === 1 && isStudioProjectImportUpload(args[0]),
} satisfies { [Name in keyof StudioFrameServiceCallsV7]: (args: unknown[]) => boolean });
export const STUDIO_FRAME_SERVICE_SCHEMA_V8 = Object.freeze({
  ...STUDIO_FRAME_SERVICE_SCHEMA_V7,
  cancelProjectImportPublication: (args: unknown[]) =>
    args.length === 3 &&
    isStudioPublicationId(args[0]) &&
    isStudioPublicationId(args[1]) &&
    isPublicationEditorScope(args[2]),
  resolveStudioProjectSource: (args: unknown[]) =>
    args.length === 2 && isStudioSourceRequest(args[0]) && isStudioEditorScope(args[1]),
  // FL-636: the bin's Library view. Additive: a frame that never calls them is unaffected, and a host
  // without them answers that the library cannot be searched.
  searchLibrary: (args: unknown[]) => args.length === 1 && isStudioLibraryQuery(args[0]),
  libraryFacets: (args: unknown[]) => args.length === 0,
  addLibraryAssets: (args: unknown[]) => args.length === 1 && isStudioLibraryAssetIds(args[0]),
});
type ServiceBindings = Omit<StudioFrameServiceCallsV7, 'commitEditorDraft' | 'reloadProject'> & {
  commitEditorDraft: {
    args: [graph: unknown, baseRevision: number, scope: StudioEditorScope];
    result: StudioEditorCommitResult;
  };
  reloadProject: { args: []; result: StudioProjectHandle };
  cancelProjectImportPublication: {
    args: [importId: string, publicationId: string, scope: StudioEditorScope];
    result: StudioCancelResult;
  };
  resolveStudioProjectSource: {
    args: [request: StudioSourceResolutionRequestDto, scope: StudioEditorScope];
    result: StudioSourceResolutionDto;
  };
  searchLibrary: { args: [query: StudioLibraryQuery]; result: StudioLibraryResults };
  libraryFacets: { args: []; result: StudioLibraryFacets };
  addLibraryAssets: { args: [assetIds: string[]]; result: StudioAssetRef[] };
};
export type StudioFrameServiceName = keyof typeof STUDIO_FRAME_SERVICE_SCHEMA_V8;
export type StudioFrameServiceCalls = { [Name in StudioFrameServiceName]: ServiceBindings[Name] };
export const isStudioFrameServiceName = (name: unknown): name is StudioFrameServiceName =>
  typeof name === 'string' && Object.hasOwn(STUDIO_FRAME_SERVICE_SCHEMA_V8, name);
