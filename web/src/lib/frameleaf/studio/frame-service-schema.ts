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
  )
    return false;
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
};
export type StudioFrameServiceName = keyof typeof STUDIO_FRAME_SERVICE_SCHEMA_V8;
export type StudioFrameServiceCalls = { [Name in StudioFrameServiceName]: ServiceBindings[Name] };
export const isStudioFrameServiceName = (name: unknown): name is StudioFrameServiceName =>
  typeof name === 'string' && Object.hasOwn(STUDIO_FRAME_SERVICE_SCHEMA_V8, name);
