import { StudioDestination } from 'src/utils/studio-resources.js';
import { STUDIO_DISTRIBUTION_APPROVAL, studioResourceRights } from 'src/utils/studio-rights.generated.js';
import {
  STUDIO_DOLBY_TOOLS_ID,
  StudioRightsUse,
  checkStudioProducerRights,
  checkStudioRights,
  studioProducerModels,
  studioRightsId,
  studioRightsUseFor,
} from 'src/utils/studio-rights.js';

const row = (uses: Partial<Record<StudioRightsUse, 'allowed' | 'blocked'>> = {}) => ({
  kind: 'font',
  license: 'OFL-1.1',
  redistribution: 'blocked' as const,
  localRuntime: 'blocked' as const,
  hostedUse: 'blocked' as const,
  ...uses,
});

describe('studio rights (FL-86)', () => {
  it('keeps every reviewed resource blocked for every use until the owner approves it', () => {
    const rows = Object.entries(studioResourceRights);
    expect(rows.length).toBeGreaterThan(200);
    expect(STUDIO_DISTRIBUTION_APPROVAL).toBe(false);
    for (const [id] of rows) {
      for (const use of Object.values(StudioRightsUse)) {
        expect(checkStudioRights(id, use)).toMatchObject({ allowed: false, id });
      }
    }
  });

  it('carries the rows the acceptance names, including the Dolby tools and MusicGen weights', () => {
    for (const id of [
      STUDIO_DOLBY_TOOLS_ID,
      'tool:dolby-artistic-trim',
      'model:Xenova/musicgen-small',
      'asset:lottiefiles',
    ]) {
      expect(studioResourceRights[id]).toBeDefined();
    }
    for (const models of Object.values(studioProducerModels)) {
      for (const id of models) {
        expect(studioResourceRights[id], id).toBeDefined();
      }
    }
  });

  it('blocks a resource with no reviewed row', () => {
    expect(checkStudioRights('font:Comic Sans', StudioRightsUse.LocalRuntime)).toEqual({
      allowed: false,
      id: 'font:Comic Sans',
      detail: 'font:Comic Sans has no reviewed rights decision, so it is blocked.',
    });
  });

  it('admits exactly the approved use', () => {
    const table = { 'font:A': row({ localRuntime: 'allowed' }) };
    expect(checkStudioRights('font:A', StudioRightsUse.LocalRuntime, table)).toEqual({ allowed: true, id: 'font:A' });
    expect(checkStudioRights('font:A', StudioRightsUse.HostedUse, table).allowed).toBe(false);
    expect(checkStudioRights('font:A', StudioRightsUse.Redistribution, table).allowed).toBe(false);
  });

  it('refuses redistribution while the engine distribution is unapproved, even for an approved row', () => {
    const table = { 'font:A': row({ redistribution: 'allowed' }) };
    expect(checkStudioRights('font:A', StudioRightsUse.Redistribution, table, false)).toMatchObject({
      allowed: false,
      detail: 'font:A: redistribution is blocked until the engine distribution is approved.',
    });
    expect(checkStudioRights('font:A', StudioRightsUse.Redistribution, table, true).allowed).toBe(true);
  });

  it('maps destinations to uses and catalogue entries to rows', () => {
    expect(studioRightsUseFor(StudioDestination.Local)).toBe(StudioRightsUse.LocalRuntime);
    expect(studioRightsUseFor(StudioDestination.Lan)).toBe(StudioRightsUse.LocalRuntime);
    expect(studioRightsUseFor(StudioDestination.FrameleafCloud)).toBe(StudioRightsUse.HostedUse);
    expect(studioRightsId('model', 'Xenova/musicgen-small')).toBe('model:Xenova/musicgen-small');
  });

  it('admits a model-backed producer when any model of its family is approved', () => {
    expect(checkStudioProducerRights('proxy', StudioRightsUse.LocalRuntime)).toBeNull();
    // A producer the server does not know is refused, not admitted by default.
    expect(checkStudioProducerRights('mystery-model', StudioRightsUse.LocalRuntime)).toMatchObject({ allowed: false });
    expect(checkStudioProducerRights('constructor', StudioRightsUse.LocalRuntime)).toMatchObject({ allowed: false });
    expect(checkStudioProducerRights('tts', StudioRightsUse.LocalRuntime)).toMatchObject({ allowed: false });
    const table = { 'model:supertonic-3': row({ localRuntime: 'allowed' }) };
    expect(checkStudioProducerRights('tts', StudioRightsUse.LocalRuntime, table)).toEqual({
      allowed: true,
      id: 'model:supertonic-3',
    });
    expect(checkStudioProducerRights('musicgen', StudioRightsUse.LocalRuntime, table)).toMatchObject({
      allowed: false,
      id: 'model:Xenova/musicgen-small',
    });
  });
});
