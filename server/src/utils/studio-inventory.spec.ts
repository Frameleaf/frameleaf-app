import { describe, expect, it } from 'vitest';
import type { StudioResourceRights } from 'src/utils/studio-rights.generated.js';
import { buildStudioAuthorizedInventory, studioProjectResourceUses } from 'src/utils/studio-inventory.js';

const row = (overrides: Partial<StudioResourceRights> = {}): StudioResourceRights => ({
  kind: 'model',
  license: 'apache-2.0',
  redistribution: 'allowed',
  localRuntime: 'allowed',
  hostedUse: 'allowed',
  approvedOn: '2026-09-25',
  restrictions: {},
  ...overrides,
});

describe('buildStudioAuthorizedInventory (FL-348)', () => {
  it('lists every reviewed resource with its licence, uses and capability', () => {
    const inventory = buildStudioAuthorizedInventory(
      {
        'model:onnx-community/whisper-base_timestamped': row({ license: null }),
        'model:Xenova/musicgen-small': row({
          license: 'cc-by-nc-4.0',
          hostedUse: 'blocked',
          restrictions: { hostedUse: 'Non-commercial licence.' },
        }),
        'font:Roboto': row({ kind: 'font', license: 'OFL-1.1' }),
        'model:Xenova/clip-vit-base-patch32': row(),
      },
      true,
    );
    expect(inventory.distributionApproved).toBe(true);
    expect(inventory.items.map((item) => item.id)).toEqual([
      'font:Roboto',
      'model:Xenova/clip-vit-base-patch32',
      'model:Xenova/musicgen-small',
      'model:onnx-community/whisper-base_timestamped',
    ]);
    const [font, clip, musicgen, whisper] = inventory.items;
    expect(font).toMatchObject({ kind: 'font', name: 'Roboto', license: 'OFL-1.1', capability: null, producers: [] });
    expect(clip.capability).toBeNull();
    expect(musicgen).toMatchObject({
      capability: 'generationWorker',
      producers: ['musicgen'],
      uses: { redistribution: true, localRuntime: true, hostedUse: false },
      restrictions: { hostedUse: 'Non-commercial licence.' },
    });
    expect(whisper).toMatchObject({ capability: 'transcriptionWorker', producers: ['transcript'], license: null });
  });

  it('blocks every redistribution while the engine distribution is not approved', () => {
    const [item] = buildStudioAuthorizedInventory({ 'font:Roboto': row({ kind: 'font' }) }, false).items;
    expect(item.uses).toEqual({ redistribution: false, localRuntime: true, hostedUse: true });
  });

  it('covers the generated rights table', () => {
    const inventory = buildStudioAuthorizedInventory();
    expect(inventory.items.length).toBeGreaterThan(100);
    expect(inventory.items.some((item) => item.kind === 'font')).toBe(true);
    expect(inventory.items.some((item) => item.kind === 'model' && item.capability === 'transcriptionWorker')).toBe(
      true,
    );
  });
});

describe('studioProjectResourceUses (FL-348)', () => {
  it('names each referenced font once, with whether it may run here', () => {
    const graph = {
      id: 'g',
      timeline: {
        tracks: [{ id: 'v1', items: [] }],
        items: [
          { id: 'a', type: 'text', trackId: 'v1', fontFamily: 'Roboto' },
          { id: 'b', type: 'text', trackId: 'v1', fontFamily: 'Roboto' },
          { id: 'c', type: 'text', trackId: 'v1', fontFamily: 'Unknown Sans' },
        ],
      },
    };
    const uses = studioProjectResourceUses(graph, { 'font:Roboto': row({ kind: 'font', license: 'OFL-1.1' }) });
    expect(uses).toEqual([
      { kind: 'font', name: 'Roboto', rightsId: 'font:Roboto', license: 'OFL-1.1', allowed: true, detail: null },
      expect.objectContaining({ name: 'Unknown Sans', rightsId: 'font:Unknown Sans', allowed: false, license: null }),
    ]);
  });

  it('answers nothing for an empty project', () => {
    expect(studioProjectResourceUses(null)).toEqual([]);
  });
});
