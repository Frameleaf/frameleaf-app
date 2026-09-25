import { StudioDestination } from 'src/utils/studio-resources.js';
import {
  STUDIO_DISTRIBUTION_APPROVAL,
  STUDIO_RIGHTS_APPROVAL,
  studioResourceRights,
} from 'src/utils/studio-rights.generated.js';
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
  approvedOn: null,
  restrictions: {},
  ...uses,
});

const MUSICGEN = 'model:Xenova/musicgen-small';

describe('studio rights (FL-86)', () => {
  it('keeps MusicGen-small local only: its CC-BY-NC-4.0 licence withholds hosted use (FL-146 comment 34944)', () => {
    expect(studioResourceRights[MUSICGEN]).toMatchObject({
      license: 'cc-by-nc-4.0',
      localRuntime: 'allowed',
      hostedUse: 'blocked',
      approvedOn: '2026-09-25',
    });
    expect(checkStudioRights(MUSICGEN, StudioRightsUse.LocalRuntime)).toEqual({ allowed: true, id: MUSICGEN });
    const hosted = checkStudioRights(MUSICGEN, StudioRightsUse.HostedUse);
    expect(hosted).toMatchObject({ allowed: false, id: MUSICGEN });
    expect(hosted.allowed ? '' : hosted.detail).toMatch(/hosted use is not allowed\. CC-BY-NC-4\.0/);
    // Music generation on the cloud destination is refused by name; on this server it resolves.
    expect(checkStudioProducerRights('musicgen', studioRightsUseFor(StudioDestination.RunPod))).toMatchObject({
      allowed: false,
      id: MUSICGEN,
    });
    expect(checkStudioProducerRights('musicgen', studioRightsUseFor(StudioDestination.Local))).toEqual({
      allowed: true,
      id: MUSICGEN,
    });
    // Every other approved row keeps hosted use.
    const hostedBlocked = Object.entries(studioResourceRights)
      .filter(([, rights]) => rights.hostedUse !== 'allowed')
      .map(([id]) => id);
    expect(hostedBlocked).toEqual([MUSICGEN]);
  });

  it('admits every one of the 210 resources the owner approved, and records the approval (FL-146)', () => {
    const rows = Object.entries(studioResourceRights);
    expect(rows).toHaveLength(210);
    expect(STUDIO_RIGHTS_APPROVAL).toMatchObject({
      approvedOn: '2026-09-25',
      source: expect.stringContaining('FL-146'),
    });
    for (const [id, rights] of rows) {
      expect(rights.approvedOn, id).toBe('2026-09-25');
      expect(checkStudioRights(id, StudioRightsUse.LocalRuntime)).toEqual({ allowed: true, id });
      if (id !== MUSICGEN) {
        expect(checkStudioRights(id, StudioRightsUse.HostedUse)).toEqual({ allowed: true, id });
      }
      // The rows allow redistribution; the engine distribution itself is still unapproved.
      expect(rights.redistribution).toBe('allowed');
      expect(checkStudioRights(id, StudioRightsUse.Redistribution).allowed).toBe(STUDIO_DISTRIBUTION_APPROVAL);
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
    expect(studioRightsUseFor(StudioDestination.RunPod)).toBe(StudioRightsUse.HostedUse);
    expect(studioRightsId('model', 'Xenova/musicgen-small')).toBe('model:Xenova/musicgen-small');
  });

  it('admits a model-backed producer when any model of its family is approved', () => {
    expect(checkStudioProducerRights('proxy', StudioRightsUse.LocalRuntime)).toBeNull();
    // A producer the server does not know is refused, not admitted by default.
    expect(checkStudioProducerRights('mystery-model', StudioRightsUse.LocalRuntime)).toMatchObject({ allowed: false });
    expect(checkStudioProducerRights('constructor', StudioRightsUse.LocalRuntime)).toMatchObject({ allowed: false });
    // Every TTS model is approved, so the producer resolves; with an empty table it does not.
    expect(checkStudioProducerRights('tts', StudioRightsUse.LocalRuntime)).toMatchObject({ allowed: true });
    expect(checkStudioProducerRights('tts', StudioRightsUse.LocalRuntime, {})).toMatchObject({ allowed: false });
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
