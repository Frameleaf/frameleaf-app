import { ZodValidationPipe } from 'nestjs-zod';
import { AssetEditAction, AssetEditsCreateDto } from 'src/dtos/editing.dto.js';

describe('AssetEditsCreateDto', () => {
  const parse = (action: AssetEditAction | string, parameters: unknown) =>
    AssetEditsCreateDto.schema.parse({ edits: [{ action, parameters }] }).edits[0];

  it.each([
    [AssetEditAction.Crop, { x: 0, y: 0, width: 10, height: 20 }],
    [AssetEditAction.Rotate, { angle: 90 }],
    [AssetEditAction.Mirror, { axis: 'horizontal' }],
    [AssetEditAction.Trim, { startMs: 10, endMs: 100 }],
    [AssetEditAction.Straighten, { angle: -12.5 }],
    [AssetEditAction.Adjust, { brightness: 10, saturation: -20 }],
    [AssetEditAction.Filter, { name: 'warm', intensity: 25 }],
    [AssetEditAction.Effect, { name: 'grain', intensity: 50 }],
    [AssetEditAction.AutoEnhance, { enabled: false }],
    [AssetEditAction.Stabilize, { enabled: false }],
    [AssetEditAction.TextOverlay, { text: 'caption', x: 0.5, y: 0.2, size: 0.1, color: '#ffffff' }],
    [AssetEditAction.Audio, { volume: 1.5, muted: true }],
    [AssetEditAction.Speed, { rate: 2, startMs: 10, endMs: 100 }],
    // FL-113: the quick editor's fast trim, develop model and anchored, shadowed text.
    [AssetEditAction.Trim, { startMs: 10, endMs: 100, mode: 'fast' }],
    [
      AssetEditAction.Adjust,
      {
        model: 'develop',
        exposure: -0.5,
        whites: 10,
        blacks: -10,
        temperature: 20,
        vibrance: 15,
        clarity: 5,
        dehaze: 5,
        grain: 10,
        sharpen: 10,
        noiseReduction: 10,
        preset: 'B&W',
        presetStrength: 60,
      },
    ],
    [
      AssetEditAction.TextOverlay,
      { text: 'caption', x: 0, y: 1, position: 'bottom-left', shadow: true, size: 0.012, color: '#ffffff' },
    ],
  ])('preserves %s parameters through runtime validation', (action, parameters) => {
    expect(parse(action, parameters)).toEqual({ action, parameters });
  });

  it('uses the runtime DTO through the Nest request validation pipe', () => {
    const input = { edits: [{ action: AssetEditAction.Audio, parameters: { volume: 1.5, muted: true } }] };
    expect(new ZodValidationPipe().transform(input, { type: 'body', metatype: AssetEditsCreateDto })).toEqual(input);
  });

  it('applies defaults only from the selected action', () => {
    expect(parse(AssetEditAction.Filter, { name: 'warm' }).parameters).toEqual({ name: 'warm', intensity: 100 });
    expect(parse(AssetEditAction.AutoEnhance, {}).parameters).toEqual({ enabled: true });
    expect(parse(AssetEditAction.Audio, {}).parameters).toEqual({});
  });

  it.each([
    [AssetEditAction.Speed, { rate: 0 }],
    [AssetEditAction.Speed, { rate: 2, startMs: 10 }],
    [AssetEditAction.Speed, { rate: 2, startMs: 100, endMs: 10 }],
    [AssetEditAction.Audio, { volume: 3 }],
    [AssetEditAction.Straighten, { angle: 90 }],
    [AssetEditAction.Trim, { startMs: 100, endMs: 10 }],
    [AssetEditAction.Rotate, { angle: 45 }],
    [AssetEditAction.Crop, null],
    ['future-action', { nested: [null, { expression: 'time * 2' }] }],
  ])('rejects unsupported or invalid %s parameters', (action, parameters) => {
    expect(() => parse(action, parameters)).toThrow();
  });

  it('retains duplicate-action rules after validation', () => {
    const speed = { action: AssetEditAction.Speed, parameters: { rate: 2, startMs: 10, endMs: 20 } };
    expect(() => AssetEditsCreateDto.schema.parse({ edits: [speed, speed] })).toThrow();
    expect(
      AssetEditsCreateDto.schema.parse({
        edits: [speed, { ...speed, parameters: { rate: 2, startMs: 20, endMs: 30 } }],
      }).edits,
    ).toHaveLength(2);
  });
});
