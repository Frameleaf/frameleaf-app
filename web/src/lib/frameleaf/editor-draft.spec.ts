import {
  AssetDevelopPreset,
  AssetDevelopRevisionKind,
  AssetDevelopRevisionStatus,
  type AssetDevelopRevisionResponseDto,
} from '@frameleaf/sdk';
import {
  anyRevisionBusy,
  changeDraft,
  createDraft,
  geometryIsDefault,
  initialRecipe,
  normalizeRecipe,
  openingRecipe,
  pickSettings,
  redoDraft,
  resetGeometry,
  sameRecipe,
  toServerRecipe,
  undoDraft,
  rebaseDraft,
} from '$lib/frameleaf/editor-draft';

const revision = (overrides: Partial<AssetDevelopRevisionResponseDto> = {}): AssetDevelopRevisionResponseDto => ({
  id: 'rev-1',
  assetId: 'asset',
  revision: 1,
  label: null,
  status: AssetDevelopRevisionStatus.Rendered,
  progress: 100,
  error: null,
  recipe: { version: 1, contrast: 30 },
  rendererVersion: 'frameleaf-develop/1',
  width: 100,
  height: 100,
  isCurrent: true,
  hasMaster: true,
  hasPreview: true,
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
  renderedAt: '2026-09-22T10:00:00.000Z',
  kind: AssetDevelopRevisionKind.Recipe,
  attempts: 1,
  exportId: null,
  fileName: null,
  software: null,
  sourceChecksum: null,
  renditionChecksum: null,
  ...overrides,
});

describe('editor draft', () => {
  it('normalizes a partial or invalid recipe into the contract', () => {
    const recipe = normalizeRecipe({ exposure: 9, rotation: 100, preset: 'Nope', crop: { x: 0.5, w: 0.8 } });
    expect(recipe.exposure).toBe(2);
    expect(recipe.rotation).toBe(90);
    expect(recipe.preset).toBe(AssetDevelopPreset.Original);
    expect(recipe.crop).toEqual({ x: 0.2, y: 0, w: 0.8, h: 1 });
    expect(recipe.aspect).toBe('Free');
    expect(normalizeRecipe(undefined)).toEqual(initialRecipe());
  });

  it('strips the client-only aspect from the wire shape', () => {
    const server = toServerRecipe({ ...initialRecipe(), aspect: '1:1', contrast: 5 });
    expect('aspect' in server).toBe(false);
    expect(server).toMatchObject({ version: 1, contrast: 5 });
    expect(sameRecipe({ ...initialRecipe(), aspect: '1:1' }, initialRecipe())).toBe(true);
  });

  it('records undo history for real changes only', () => {
    const draft = createDraft();
    const same = changeDraft(draft, { contrast: 0 });
    expect(same).toBe(draft);
    const changed = changeDraft(draft, { contrast: 25 });
    expect(changed.recipe.contrast).toBe(25);
    expect(changed.undo).toHaveLength(1);
    const undone = undoDraft(changed);
    expect(undone.recipe.contrast).toBe(0);
    expect(undone.redo).toHaveLength(1);
    expect(redoDraft(undone).recipe.contrast).toBe(25);
    expect(undoDraft(draft)).toBe(draft);
  });

  it('copies only the develop settings, never the geometry', () => {
    const settings = pickSettings({
      ...initialRecipe(),
      contrast: 12,
      preset: AssetDevelopPreset.Warm,
      crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      rotation: 90,
    });
    expect(settings).toMatchObject({ contrast: 12, preset: AssetDevelopPreset.Warm, presetStrength: 100 });
    expect('crop' in settings).toBe(false);
    expect('rotation' in settings).toBe(false);
  });

  it('tracks geometry defaults', () => {
    expect(geometryIsDefault(initialRecipe())).toBe(true);
    expect(geometryIsDefault({ ...initialRecipe(), straighten: 2 })).toBe(false);
    expect(geometryIsDefault(normalizeRecipe({ ...initialRecipe(), ...resetGeometry(), flipVertical: true }))).toBe(
      false,
    );
  });

  it('sends a keystone correction only when it corrects, or clears a stored one', () => {
    expect('perspective' in toServerRecipe(initialRecipe())).toBe(false);
    const corrected = changeDraft(createDraft(), { perspective: { vertical: 120, horizontal: -30.4 } }).recipe;
    expect(corrected.perspective).toEqual({ vertical: 100, horizontal: -30 });
    expect(toServerRecipe(corrected).perspective).toEqual({ vertical: 100, horizontal: -30 });
    expect(geometryIsDefault(corrected)).toBe(false);
    expect(normalizeRecipe({ ...corrected, ...resetGeometry() }).perspective).toEqual({ vertical: 0, horizontal: 0 });
    const stored = createDraft({ version: 1, perspective: { vertical: 20, horizontal: 0 }, keyFrame: { timeMs: 900 } });
    const cleared = toServerRecipe(changeDraft(stored, { perspective: { vertical: 0, horizontal: 0 } }).recipe);
    expect(cleared.perspective).toEqual({ vertical: 0, horizontal: 0 });
    // a key frame chosen on another device is carried, never dropped
    expect(cleared.keyFrame).toEqual({ timeMs: 900 });
  });

  it('opens with the current version recipe, or the original', () => {
    expect(openingRecipe({ currentRevisionId: 'rev-1', revisions: [revision()] }).contrast).toBe(30);
    expect(openingRecipe({ currentRevisionId: null, revisions: [revision()] })).toEqual(initialRecipe());
    expect(openingRecipe(null)).toEqual(initialRecipe());
  });

  it('knows when a render is still in flight', () => {
    expect(anyRevisionBusy([revision()])).toBe(false);
    expect(anyRevisionBusy([revision({ status: AssetDevelopRevisionStatus.Rendering, progress: 40 })])).toBe(true);
  });
});

describe('rebaseDraft', () => {
  it('opens on the loaded recipe when nothing was touched', () => {
    const loaded = { ...initialRecipe(), contrast: 40 };
    const draft = rebaseDraft(createDraft(), loaded);
    expect(draft.recipe.contrast).toBe(40);
    expect(draft.undo).toEqual([]);
  });

  it('keeps an adjustment made while the recipe was loading, one undo away from the loaded recipe', () => {
    const early = changeDraft(createDraft(), { exposure: 0.5 });
    const draft = rebaseDraft(early, { ...initialRecipe(), contrast: 40 });
    expect(draft.recipe.exposure).toBe(0.5);
    expect(draft.recipe.contrast).toBe(40);
    expect(draft.undo).toHaveLength(1);
    expect(draft.undo[0].exposure).toBe(0);
    expect(draft.undo[0].contrast).toBe(40);
  });
});

it('carries future recipe and nested opaque data through edits and undo/redo (FL-233)', () => {
  const recipe = {
    version: 2,
    contrast: 12,
    future: { operations: [{ method: 'remove', fill: 'opaque' }] },
    crop: { x: 0, y: 0, w: 1, h: 1, future: 'retained' },
  };
  const draft = changeDraft(createDraft(recipe), { contrast: 25 });
  const result = toServerRecipe(redoDraft(undoDraft(draft)).recipe);
  expect(result).toMatchObject({ ...recipe, contrast: 25 });
});

it('keeps unknown properties nested in masks and adjustments through known edits/history/save', () => {
  const recipe = {
    version: 1,
    masks: [
      {
        id: 'a',
        kind: 'radial',
        x: 0.5,
        y: 0.5,
        future: { bitmap: 'opaque' },
        adjustments: { exposure: 0, future: 12 },
      },
      { id: 'future', kind: 'subject', bitmap: { hash: 'abc' } },
    ],
  };
  const draft = changeDraft(createDraft(recipe), { contrast: 25 });
  const saved = toServerRecipe(redoDraft(undoDraft(draft)).recipe);
  expect(saved.masks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'a',
        future: { bitmap: 'opaque' },
        adjustments: expect.objectContaining({ future: 12 }),
      }),
      recipe.masks[1],
    ]),
  );
});
it('does not replace untouched future meanings with the current UI projection defaults', () => {
  const recipe = {
    version: 2,
    contrast: { curve: [0, 1] },
    crop: { mesh: [1, 2] },
    future: { operations: ['opaque'] },
  };
  expect(toServerRecipe(createDraft(recipe).recipe)).toEqual(recipe);
  expect(toServerRecipe(createDraft().recipe)).not.toHaveProperty('future');
});

it('preserves wire keys that collide with client-only bookkeeping through load/history/save', () => {
  const recipe = { version: 1, aspect: { future: 'wire data' }, opaqueRecipe: { version: 88, future: 'wire data' } };
  const edited = changeDraft(createDraft(recipe), { contrast: 12 });
  expect(toServerRecipe(redoDraft(undoDraft(edited)).recipe)).toMatchObject(recipe);
});

it('replays early known edits on loaded opaque data instead of replacing the loaded envelope', () => {
  const early = changeDraft(createDraft(), { contrast: 25 });
  const loaded = { version: 1, future: { fill: 'opaque' } };
  expect(toServerRecipe(rebaseDraft(early, loaded).recipe)).toMatchObject({ ...loaded, contrast: 25 });
});

it('explicit new-original reset removes inherited opaque data and undo restores it', () => {
  const loaded = createDraft({ version: 1, future: { fill: 'opaque' } });
  const reset = changeDraft(loaded, { ...initialRecipe(), opaqueRecipe: undefined });
  expect(toServerRecipe(reset.recipe)).not.toHaveProperty('future');
  expect(toServerRecipe(undoDraft(reset).recipe)).toHaveProperty('future');
});

it('carries native Brilliance, brush and bitmap masks and Clean Up through a web edit (FL-233)', () => {
  const brush = { id: 'b', kind: 'brush', strokes: [{ points: [[0.2, 0.3]], radius: 0.05, erase: false }] };
  const sky = { id: 's', kind: 'sky', artifact: 'a'.repeat(64), adjustments: { exposure: -0.5 } };
  const cleanup = [{ id: 'p', method: 'pixelate', region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }];
  const recipe = { version: 1, brilliance: 40, masks: [brush, sky], cleanup };
  const saved = toServerRecipe(changeDraft(createDraft(recipe), { contrast: 10 }).recipe);
  expect(saved).toMatchObject({ contrast: 10, brilliance: 40, cleanup });
  expect(saved.masks).toEqual(expect.arrayContaining([brush, sky]));
});

it("saves a preset's Brilliance with the photo, one undo step back from it (FL-304)", () => {
  const draft = createDraft({ version: 1, brilliance: 10, contrast: 5 });
  const applied = changeDraft(draft, { contrast: 20, opaqueRecipe: { ...draft.recipe.opaqueRecipe!, brilliance: 40 } });
  expect(toServerRecipe(applied.recipe)).toMatchObject({ contrast: 20, brilliance: 40 });
  expect(toServerRecipe(undoDraft(applied).recipe)).toMatchObject({ contrast: 5, brilliance: 10 });
});

it('upgrades a new HDR edit while retaining historical and native recipe identities', () => {
  const hdr = toServerRecipe(openingRecipe(null, true));
  expect(hdr).toMatchObject({
    version: 6,
    renderer: 'frameleaf-develop-hdr/4',
    hdr: { intent: 'preserve', referenceWhite: 203 },
  });
  const native = revision({ recipe: { version: 2, native: { renderer: 'darktable/5.6.1' } } });
  expect(toServerRecipe(openingRecipe({ currentRevisionId: native.id, revisions: [native] }, true)).version).toBe(2);
  const previous = revision({ recipe: { version: 1, contrast: 30 } });
  expect(toServerRecipe(openingRecipe({ currentRevisionId: previous.id, revisions: [previous] }, true))).toMatchObject({
    version: 6,
    contrast: 30,
  });
  expect(previous.recipe.version).toBe(1);
});

it('upgrades a historical HDR draft without changing its source or dropping opaque fields', () => {
  const old = revision({
    recipe: {
      version: 3,
      renderer: 'frameleaf-develop-hdr/1',
      contrast: 30,
      future: { preserved: true },
      hdr: { version: 1, extra: 'retained' },
    },
  });
  const draft = toServerRecipe(openingRecipe({ currentRevisionId: old.id, revisions: [old] }, true));
  expect(draft).toMatchObject({
    version: 6,
    renderer: 'frameleaf-develop-hdr/4',
    contrast: 30,
    future: { preserved: true },
    hdr: { version: 4, extra: 'retained' },
  });
  expect(old.recipe).toMatchObject({ version: 3, hdr: { version: 1 } });
  const unknown = revision({ recipe: { version: 3, renderer: 'future-renderer' } });
  expect(toServerRecipe(openingRecipe({ currentRevisionId: unknown.id, revisions: [unknown] }, true))).toMatchObject({
    version: 3,
    renderer: 'future-renderer',
  });
});

it('promotes a recognized version 4 draft and retains its immutable recipe and opaque fields', () => {
  const old = revision({
    recipe: {
      version: 4,
      renderer: 'frameleaf-develop-hdr/2',
      future: 'retained',
      hdr: { version: 2, sdrToneMapper: 'libultrahdr/2.0.2-frameleaf.2', extra: 123 },
    },
  });
  expect(toServerRecipe(openingRecipe({ currentRevisionId: old.id, revisions: [old] }, true))).toMatchObject({
    version: 6,
    renderer: 'frameleaf-develop-hdr/4',
    future: 'retained',
    hdr: { version: 4, sdrToneMapper: 'libultrahdr/2.0.2-frameleaf.4', extra: 123 },
  });
  expect(old.recipe).toMatchObject({ version: 4, hdr: { version: 2 } });
});

it('promotes version 5 only when its renderer policy is recognized', () => {
  const old = revision({
    recipe: {
      version: 5,
      renderer: 'frameleaf-develop-hdr/3',
      future: true,
      hdr: { version: 3, sdrToneMapper: 'libultrahdr/2.0.2-frameleaf.3', extra: 'kept' },
    },
  });
  expect(toServerRecipe(openingRecipe({ currentRevisionId: old.id, revisions: [old] }, true))).toMatchObject({
    version: 6,
    renderer: 'frameleaf-develop-hdr/4',
    future: true,
    hdr: { version: 4, sdrToneMapper: 'libultrahdr/2.0.2-frameleaf.4', extra: 'kept' },
  });
  expect(old.recipe).toMatchObject({ version: 5, hdr: { version: 3 } });
  const unknown = revision({ recipe: { ...old.recipe, hdr: { version: 99 } } });
  expect(toServerRecipe(openingRecipe({ currentRevisionId: unknown.id, revisions: [unknown] }, true))).toMatchObject(
    unknown.recipe,
  );
});
