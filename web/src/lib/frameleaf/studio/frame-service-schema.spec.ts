import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { STUDIO_FRAME_PROTOCOL_VERSION } from './frame-protocol';
import {
  STUDIO_FRAME_SERVICE_SCHEMA_V7,
  STUDIO_FRAME_SERVICE_SCHEMA_V8,
  isStudioFrameServiceName,
  isStudioSourceRequest,
} from './frame-service-schema';

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
    expect(STUDIO_FRAME_PROTOCOL_VERSION).toBe(8);
    expect(Object.keys(STUDIO_FRAME_SERVICE_SCHEMA_V7)).toEqual(oldNames);
    expect(Object.keys(STUDIO_FRAME_SERVICE_SCHEMA_V8)).toEqual([
      ...oldNames,
      'cancelProjectImportPublication',
      'resolveStudioProjectSource',
    ]);
    expect(Object.hasOwn(STUDIO_FRAME_SERVICE_SCHEMA_V7, 'resolveStudioProjectSource')).toBe(false);
    for (const name of ['resolveVectorSource', 'vector-sources', '__proto__', 'constructor', 'unknown'])
      expect(isStudioFrameServiceName(name)).toBe(false);
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
    ])
      expect(check(bad)).toBe(false);
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
    ])
      expect(isStudioSourceRequest(bad)).toBe(false);
  });
  it('keeps canonical DTO properties/enums bound to the canonical OpenAPI checkpoint', () => {
    const spec = JSON.parse(
      readFileSync(new URL('../../../../../open-api/immich-openapi-specs.json', import.meta.url), 'utf8'),
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
    const vite = readFileSync(new URL('../../../../../studio/adapters/web/vite.config.mjs', import.meta.url), 'utf8');
    expect(vite).toContain('protocolVersion: STUDIO_FRAME_PROTOCOL_VERSION');
  });
});
