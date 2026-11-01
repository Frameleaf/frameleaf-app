import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STUDIO_FRAME_PROTOCOL_VERSION } from './frame-protocol';
import {
  STUDIO_FRAME_SERVICE_SCHEMA_V7,
  STUDIO_FRAME_SERVICE_SCHEMA_V8,
  STUDIO_FRAME_SERVICE_SCHEMA_V9,
  STUDIO_LIBRARY_ADD_LIMIT,
  isStudioFrameServiceName,
  isStudioLibraryQuery,
  isStudioSourceRequest,
} from './frame-service-schema';

describe('FL-641 caption translation in protocol 9', () => {
  const check = STUDIO_FRAME_SERVICE_SCHEMA_V9.translateCaptions;

  it('adds translateCaptions only to protocol 9', () => {
    expect(Object.keys(STUDIO_FRAME_SERVICE_SCHEMA_V9)).toEqual([
      ...Object.keys(STUDIO_FRAME_SERVICE_SCHEMA_V8),
      'translateCaptions',
      'searchLibrary',
      'libraryFacets',
      'addLibraryAssets',
      // FL-639: Cut out the subject, optional host services.
      'listCutoutSubjects',
      'startCutout',
      'readCutout',
    ]);
    for (const name of [
      'searchLibrary',
      'libraryFacets',
      'addLibraryAssets',
      'listCutoutSubjects',
      'startCutout',
      'readCutout',
    ]) {
      expect(Object.hasOwn(STUDIO_FRAME_SERVICE_SCHEMA_V8, name), name).toBe(false);
    }
    expect(Object.hasOwn(STUDIO_FRAME_SERVICE_SCHEMA_V8, 'translateCaptions')).toBe(false);
    expect(isStudioFrameServiceName('translateCaptions')).toBe(true);
  });

  it('accepts two offered languages and caption text, nothing else', () => {
    expect(check([{ source: 'en', target: 'fr', lines: ['Hello', ''] }])).toBe(true);
    for (const bad of [
      [],
      [{ source: 'en', target: 'fr', lines: ['Hi'] }, true],
      [{ source: 'en', target: 'ja', lines: ['Hi'] }],
      [{ source: 'en', target: 'en', lines: ['Hi'] }],
      [{ source: 'en', target: 'fr', lines: [] }],
      [{ source: 'en', target: 'fr', lines: [1] }],
      [{ source: 'en', target: 'fr', lines: ['x'.repeat(1001)] }],
      [{ source: 'en', target: 'fr', lines: Array.from({ length: 501 }, () => 'x') }],
      [{ source: 'en', target: 'fr', lines: ['Hi'], projectId: 'other' }],
    ]) {
      expect(check(bad)).toBe(false);
    }
  });
});

const oldNames = [
  'submitCommands',
  'stageDraft',
  'commitEditorDraft',
  'reloadProject',
  'authorizeGeneratedMedia',
  'saveWorkspace',
  'uploadProjectImport',
];
describe('one explicitly versioned Studio service schema', () => {
  it('preserves the seven old names and retains cancellation and adds canonical source resolution only to protocol8', () => {
    expect(STUDIO_FRAME_PROTOCOL_VERSION).toBe(9);
    expect(Object.keys(STUDIO_FRAME_SERVICE_SCHEMA_V7)).toEqual(oldNames);
    expect(Object.keys(STUDIO_FRAME_SERVICE_SCHEMA_V8)).toEqual([
      ...oldNames,
      'cancelProjectImportPublication',
      'resolveStudioProjectSource',
    ]);
    expect(Object.hasOwn(STUDIO_FRAME_SERVICE_SCHEMA_V7, 'resolveStudioProjectSource')).toBe(false);
    for (const name of ['resolveVectorSource', 'vector-sources', '__proto__', 'constructor', 'unknown']) {
      expect(isStudioFrameServiceName(name)).toBe(false);
    }
  });
  it('accepts only well-formed Library view searches and adoptions (FL-636)', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(isStudioLibraryQuery({})).toBe(true);
    expect(
      isStudioLibraryQuery({ text: 'lake', type: 'video', personId: uuid, city: 'Banff', month: '2026-07', page: 2 }),
    ).toBe(true);
    expect(isStudioLibraryQuery({ text: null, personId: null, city: null, month: null })).toBe(true);
    for (const bad of [
      null,
      [],
      { albumIds: [uuid] },
      { visibility: 'locked' },
      { type: 'audio' },
      { personId: 'jamie' },
      { month: '2026-13' },
      { page: 0 },
      { text: 'x'.repeat(501) },
    ]) {
      expect(isStudioLibraryQuery(bad), JSON.stringify(bad)).toBe(false);
    }
    const add = STUDIO_FRAME_SERVICE_SCHEMA_V9.addLibraryAssets;
    expect(add([[uuid]])).toBe(true);
    expect(add([[]])).toBe(false);
    expect(add([['../etc']])).toBe(false);
    expect(add([Array.from({ length: STUDIO_LIBRARY_ADD_LIMIT + 1 }, () => uuid)])).toBe(false);
    expect(STUDIO_FRAME_SERVICE_SCHEMA_V9.libraryFacets([])).toBe(true);
    expect(STUDIO_FRAME_SERVICE_SCHEMA_V9.searchLibrary([{ month: 'July' }])).toBe(false);
  });
  it('keeps current publication cancellation in protocol8 with its independent origin checks', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const args = [uuid, uuid, { projectId: uuid, userId: uuid, graphVersion: 2 }];
    const check = STUDIO_FRAME_SERVICE_SCHEMA_V8.cancelProjectImportPublication;
    expect(isStudioFrameServiceName('cancelProjectImportPublication')).toBe(true);
    expect(Object.hasOwn(STUDIO_FRAME_SERVICE_SCHEMA_V7, 'cancelProjectImportPublication')).toBe(false);
    expect(check(args)).toBe(true);
    for (const bad of [
      args.slice(0, 2),
      [...args, true],
      ['invalid', ...args.slice(1)],
      [uuid, uuid, { ...(args[2] as object), graphVersion: -1 }],
      [uuid, uuid, { projectId: 'other', userId: uuid, graphVersion: 2 }],
    ]) {
      expect(check(bad)).toBe(false);
    }
  });
  it('accepts only canonical saved request shapes, including strict namespaces/selections', () => {
    const request = {
      revision: 1,
      graphDigest: 'a'.repeat(64),
      parent: { kind: 'project-import', id: '11111111-1111-4111-8111-111111111111', checksum: 'b'.repeat(64) },
      selection: {},
    };
    expect(isStudioSourceRequest(request)).toBe(true);
    for (const bad of [
      { ...request, revision: 0 },
      { ...request, extra: true },
      { ...request, parent: { ...request.parent, kind: 'library-asset' } },
      { ...request, selection: { animationId: '../first' } },
    ]) {
      expect(isStudioSourceRequest(bad)).toBe(false);
    }
  });
  it('keeps canonical DTO properties/enums bound to the canonical OpenAPI checkpoint', () => {
    const spec = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../../../open-api/immich-openapi-specs.json'), 'utf8'),
    );
    const schemas = spec.components.schemas;
    expect(Object.keys(schemas.StudioSourceResolutionRequestDto.properties).sort()).toEqual([
      'graphDigest',
      'parent',
      'revision',
      'selection',
    ]);
    expect(Object.keys(schemas.StudioSourceResolutionDto.properties).sort()).toEqual([
      'archive',
      'expiresAt',
      'files',
      'graphDigest',
      'manifestDigest',
      'parent',
      'projectId',
      'revision',
      'selection',
    ]);
    expect(Object.keys(schemas.StudioSourceParentDto.properties).sort()).toEqual(['checksum', 'id', 'kind']);
    expect(Object.keys(schemas.StudioSourceSelectionDto.properties).sort()).toEqual(['animationId', 'themeId']);
    expect(schemas.StudioSourceParentKind.enum).toEqual(['project-import', 'vector-graphic']);
    const vite = readFileSync(
      resolve(import.meta.dirname, '../../../../../studio/adapters/web/vite.config.mjs'),
      'utf8',
    );
    expect(vite).toContain('protocolVersion: STUDIO_FRAME_PROTOCOL_VERSION');
  });
});
