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
const CHANGED_ONNX = 'runtime:onnx-cdn';

/**
 * The Whisper runtime still matches its September 29 approval; the ONNX runtime changed again.
 */
const REAPPROVED = new Set(['runtime:whisper-transformers']);
/** The Supertonic model and the 64 voices, pinned to a commit and approved again on 2026-09-29. */
const isPinned = (id: string) => /^voice:(kokoro|supertonic)-|^model:supertonic-3$/.test(id);

describe('studio rights (FL-86)', () => {
  it('allows MusicGen-small everywhere: its CC-BY-NC-4.0 licence covers personal use (FL-451)', () => {
    expect(studioResourceRights[MUSICGEN]).toMatchObject({
      license: 'cc-by-nc-4.0',
      localRuntime: 'allowed',
      hostedUse: 'allowed',
      approvedOn: '2026-09-25',
      restrictions: {},
    });
    expect(checkStudioRights(MUSICGEN, StudioRightsUse.LocalRuntime)).toEqual({ allowed: true, id: MUSICGEN });
    expect(checkStudioRights(MUSICGEN, StudioRightsUse.HostedUse)).toEqual({ allowed: true, id: MUSICGEN });
    // Music generation resolves on the cloud destination and on this server alike.
    expect(checkStudioProducerRights('musicgen', studioRightsUseFor(StudioDestination.FrameleafCloud))).toEqual({
      allowed: true,
      id: MUSICGEN,
    });
    expect(checkStudioProducerRights('musicgen', studioRightsUseFor(StudioDestination.Local))).toEqual({
      allowed: true,
      id: MUSICGEN,
    });
    // Only the changed ONNX runtime is kept off hosted use, and no row withholds a use for its licence.
    const hostedBlocked = Object.entries(studioResourceRights)
      .filter(([, rights]) => rights.hostedUse !== 'allowed')
      .map(([id]) => id);
    expect(hostedBlocked).toEqual([CHANGED_ONNX]);
    expect(Object.values(studioResourceRights).filter((rights) => Object.keys(rights.restrictions).length > 0)).toEqual(
      [],
    );
  });

  it('admits current approvals and blocks the changed ONNX runtime (FL-146)', () => {
    const rows = Object.entries(studioResourceRights);
    expect(rows).toHaveLength(210);
    expect(STUDIO_RIGHTS_APPROVAL).toMatchObject({
      approvedOn: '2026-09-25',
      source: expect.stringContaining('FL-146'),
    });
    for (const [id, rights] of rows) {
      if (id === CHANGED_ONNX) {
        expect(rights).toMatchObject({
          approvedOn: null,
          redistribution: 'blocked',
          localRuntime: 'blocked',
          hostedUse: 'blocked',
        });
        for (const use of Object.values(StudioRightsUse)) {
          expect(checkStudioRights(id, use, studioResourceRights, true)).toMatchObject({ allowed: false, id });
        }
        continue;
      }
      if (id === 'model:onnx-community/whisper-tiny_timestamped') {
        // The owner approved this exact seven-file model inventory again on October 3.
        expect(rights.approvedOn, id).toBe('2026-10-03');
      } else if (id === 'model:Olicorne/parakeet-tdt-0.6b-v3-smoothquant-onnx') {
        // The owner approved the five-file inventory served from the Frameleaf model mirror on October 31 (FL-685).
        expect(rights.approvedOn, id).toBe('2026-10-31');
      } else {
        expect(rights.approvedOn, id).toBe(REAPPROVED.has(id) || isPinned(id) ? '2026-09-29' : '2026-09-25');
      }
      expect(checkStudioRights(id, StudioRightsUse.LocalRuntime)).toEqual({ allowed: true, id });
      expect(checkStudioRights(id, StudioRightsUse.HostedUse)).toEqual({ allowed: true, id });
      // The rows allow redistribution; the engine distribution itself is still unapproved.
      expect(rights.redistribution).toBe('allowed');
      expect(checkStudioRights(id, StudioRightsUse.Redistribution).allowed).toBe(STUDIO_DISTRIBUTION_APPROVAL);
    }
  });

  it('admits the bundled runtimes the owner approved again at their new digests (2026-09-29)', () => {
    for (const id of REAPPROVED) {
      expect(studioResourceRights[id]).toMatchObject({ approvedOn: '2026-09-29', localRuntime: 'allowed' });
      expect(checkStudioRights(id, StudioRightsUse.LocalRuntime)).toEqual({ allowed: true, id });
    }
  });

  it('admits the Supertonic model and every voice at the commits the owner approved (2026-09-29)', () => {
    const pinned = Object.keys(studioResourceRights).filter((id) => isPinned(id));
    expect(pinned).toHaveLength(65);
    for (const id of pinned) {
      expect(studioResourceRights[id]).toMatchObject({ approvedOn: '2026-09-29', localRuntime: 'allowed' });
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
