import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type LocalModelPins, parseLocalModelPins, pinnedModelOf } from 'src/utils/local-model-pins.js';

const raw = (): LocalModelPins =>
  JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-pins.json'), 'utf8'));

describe('the release Cloud pins (FL-455 A3)', () => {
  it('pin ViT-B-32__openai and antelopev2 with their mirror identities and consistent producer keys', () => {
    const pins = parseLocalModelPins(raw());
    expect(pins.epoch).toBe(1);
    expect(pins.pins.map((pin) => [pin.workload, pin.modelName])).toEqual([
      ['clip', 'ViT-B-32__openai'],
      ['face', 'antelopev2'],
    ]);
    const [clip, face] = pins.pins;
    expect(clip.modelSnapshotRevision).toBe('a857c8de2c07bbcfa6646adfcf31b798845afa1e');
    expect(clip.embeddingDimensions).toBe(512);
    expect(clip.models[0].artifacts['visual/model.onnx']).toBe(
      '33a3df41ceef21acdf371af00f6dd0456ec1f9eba24d03a7720f9c3734e40859',
    );
    expect(clip.artifactBytes['visual/model.onnx']).toBe(351_613_724);
    expect(face.modelSnapshotRevision).toBe('51ca7e153bccebdbae224779e23c9c243e2fec85');
    expect(face.models.map((model) => model.type)).toEqual(['detection', 'recognition']);
    expect(face.artifactBytes['recognition/model.onnx']).toBe(260_665_334);
    // the preprocessing identity of the current signed runtime, so a later qualified profile keeps the key
    for (const pin of pins.pins) {
      expect(pin.preprocessingSha256).toBe('8d9fc77dbb8d8c1ee262ed800a564b7cc82b0160e3c29166f724b84529ec353a');
      expect(pin.modelKey.startsWith(`${pin.workload}:`)).toBe(true);
    }
    expect(pinnedModelOf(face)).toMatchObject({
      modelKey: face.modelKey,
      workload: 'face',
      embeddingDimensions: 512,
      spec: { fixtureKind: 'image' },
    });
  });

  it('refuses a pin whose key, files, name or shape does not hold together', () => {
    const pins = raw();
    const [clip, face] = pins.pins;
    const cases: unknown[] = [
      { ...pins, pins: [{ ...clip, modelKey: `clip:${'a'.repeat(64)}` }] },
      { ...pins, pins: [{ ...clip, modelSnapshotRevision: 'b'.repeat(40) }] },
      { ...pins, pins: [{ ...clip, embeddingDimensions: 768 }] },
      { ...pins, pins: [{ ...clip, modelName: 'ViT-B-16-SigLIP-384__webli' }] },
      { ...pins, pins: [{ ...clip, artifactBytes: { ...clip.artifactBytes, 'visual/model.onnx': 1 }, extra: 1 }] },
      { ...pins, pins: [{ ...clip, artifactBytes: { ...clip.artifactBytes, 'other.onnx': 1 } }] },
      { ...pins, pins: [{ ...face, models: [face.models[1], face.models[0]] }] },
      { ...pins, pins: [{ ...face, entries: { ...face.entries, extra: true } }] },
      { ...pins, pins: [clip, clip] },
      { ...pins, schemaVersion: 2 },
      { ...pins, other: true },
    ];
    for (const value of cases) {
      expect(() => parseLocalModelPins(value), JSON.stringify(value).slice(0, 80)).toThrow();
    }
  });
});
