import {
  AssetDevelopPreset,
  AssetDevelopRevisionKind,
  AssetDevelopRevisionStatus,
  type AssetDevelopRevisionResponseDto,
} from '@immich/sdk';
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
