import { describe, expect, it } from 'vitest';
import {
  RetainedProcessingProvenanceSchema,
  assertReadyRetry,
  bindProcessingProvenance,
  parseProcessingProvenance,
  sameProvenance,
} from 'src/utils/studio-import-provenance.js';
import { LINEAGE } from 'test/fixtures/studio-import-retention.js';

const checksum = 'ab'.repeat(32);
const modelBinding = { resourceId: 'anime4k:weights.v1-2_3', sha256: 'cd'.repeat(32) };

describe('processing provenance', () => {
  it.each(['animation', 'liveAction', 'threeD'])('preserves actual completion values for %s', (variant) => {
    const input = { ...LINEAGE, variant };
    expect(parseProcessingProvenance(input)).toEqual(input);
    expect(bindProcessingProvenance(input, checksum)).toEqual({ ...input, outputSha256: checksum });
    expect(parseProcessingProvenance(input)).not.toHaveProperty('modelBinding');
  });

  it('accepts supplied complete model binding without deriving one', () => {
    expect(parseProcessingProvenance({ ...LINEAGE, modelBinding })).toEqual({ ...LINEAGE, modelBinding });
  });

  it('accepts the numeric and ASCII boundaries', () => {
    const value = {
      ...LINEAGE,
      source: { ...LINEAGE.source, id: 'A_-0'.repeat(32) },
      input: { width: 1, height: 16_384 },
      output: { width: 2, height: 32_768, fps: 1000, frameCount: Number.MAX_SAFE_INTEGER, codec: ' ~'.repeat(64) },
      modelBinding: { ...modelBinding, resourceId: 'A:._-0'.repeat(21) + 'AB' },
    };
    expect(parseProcessingProvenance(value)).toEqual(value);
    expect(
      parseProcessingProvenance({ ...LINEAGE, output: { ...LINEAGE.output, fps: Number.MIN_VALUE, frameCount: 1 } }),
    ).toEqual({ ...LINEAGE, output: { ...LINEAGE.output, fps: Number.MIN_VALUE, frameCount: 1 } });
  });

  it.each([
    undefined,
    null,
    [],
    true,
    1,
    '{}',
    '{',
    JSON.stringify(LINEAGE),
    { ...LINEAGE, version: 2 },
    { ...LINEAGE, version: '1' },
    { ...LINEAGE, family: 'rife' },
    { ...LINEAGE, evidence: 'server-certified' },
    { ...LINEAGE, variant: 'live-action' },
    { ...LINEAGE, variant: '3d' },
    { ...LINEAGE, source: { ...LINEAGE.source, namespace: 'library' } },
    { ...LINEAGE, source: { ...LINEAGE.source, projectId: 'not-a-uuid' } },
    { ...LINEAGE, outputSha256: checksum },
    { ...LINEAGE, unknown: true },
    { ...LINEAGE, source: { ...LINEAGE.source, unknown: true } },
    { ...LINEAGE, input: { ...LINEAGE.input, unknown: true } },
    { ...LINEAGE, output: { ...LINEAGE.output, unknown: true } },
    { ...LINEAGE, modelBinding: null },
    { ...LINEAGE, modelBinding: {} },
    { ...LINEAGE, modelBinding: { resourceId: modelBinding.resourceId } },
    { ...LINEAGE, modelBinding: { sha256: modelBinding.sha256 } },
    { ...LINEAGE, modelBinding: { ...modelBinding, unknown: true } },
    { ...LINEAGE, output: { ...LINEAGE.output, width: 1279 } },
    { ...LINEAGE, output: { ...LINEAGE.output, height: 719 } },
  ])('refuses malformed objects without stripping fields (%#)', (value) => {
    expect(() => parseProcessingProvenance(value)).toThrow();
  });

  it.each(['input', 'output'] as const)('bounds every %s dimension', (part) => {
    for (const dimension of ['width', 'height']) {
      for (const invalid of [0, -1, 1.5, NaN, Infinity, -Infinity, 32_769, '640', null]) {
        expect(() =>
          parseProcessingProvenance({ ...LINEAGE, [part]: { ...LINEAGE[part], [dimension]: invalid } }),
        ).toThrow();
      }
    }
  });

  it.each([0, -1, Infinity, -Infinity, NaN, 1000.01, '29.97', null])('refuses invalid FPS %s', (fps) => {
    expect(() => parseProcessingProvenance({ ...LINEAGE, output: { ...LINEAGE.output, fps } })).toThrow();
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '30', null])(
    'refuses invalid frame count %s',
    (frameCount) => {
      expect(() => parseProcessingProvenance({ ...LINEAGE, output: { ...LINEAGE.output, frameCount } })).toThrow();
    },
  );

  it.each(['', 'a'.repeat(129), '../media', '/media', 'https://example.test/media', 'a b', 'é', 'a\n', 'a\0'])(
    'refuses unsafe source label %j',
    (id) => {
      expect(() => parseProcessingProvenance({ ...LINEAGE, source: { ...LINEAGE.source, id } })).toThrow();
    },
  );

  it.each([
    '',
    'a'.repeat(129),
    '../weights/file',
    '/weights',
    'https://example.test/weights',
    'a b',
    'é',
    'a\n',
    'a\0',
  ])('refuses unsafe model label %j', (resourceId) => {
    expect(() => parseProcessingProvenance({ ...LINEAGE, modelBinding: { ...modelBinding, resourceId } })).toThrow();
  });

  it.each(['', 'a'.repeat(129), 'é', 'avc1\n', 'avc1\0', '\u{7F}'])('refuses invalid codec %j', (codec) => {
    expect(() => parseProcessingProvenance({ ...LINEAGE, output: { ...LINEAGE.output, codec } })).toThrow();
  });

  it.each(['', 'ab'.repeat(31), 'ab'.repeat(33), 'AB'.repeat(32), 'gg'.repeat(32), '../hash'])(
    'refuses invalid model and output hashes %j',
    (sha256) => {
      expect(() => parseProcessingProvenance({ ...LINEAGE, modelBinding: { ...modelBinding, sha256 } })).toThrow();
      expect(() => bindProcessingProvenance(LINEAGE, sha256)).toThrow('invalid_output_checksum');
      expect(() => RetainedProcessingProvenanceSchema.parse({ ...LINEAGE, outputSha256: sha256 })).toThrow();
    },
  );

  it('keeps the largest bounded v1 fields below 4 KiB and refuses malformed oversized input', () => {
    const largest = {
      ...LINEAGE,
      variant: 'liveAction',
      source: { ...LINEAGE.source, id: 'a'.repeat(128) },
      input: { width: 16_384, height: 16_384 },
      output: {
        width: 32_768,
        height: 32_768,
        fps: Number.MIN_VALUE,
        frameCount: Number.MAX_SAFE_INTEGER,
        codec: '"'.repeat(128),
      },
      modelBinding: { resourceId: 'a'.repeat(128), sha256: checksum },
    };
    const retained = bindProcessingProvenance(largest, checksum);
    expect(Buffer.byteLength(JSON.stringify(retained), 'utf8')).toBeLessThanOrEqual(4096);
    expect(() =>
      parseProcessingProvenance({ ...LINEAGE, source: { ...LINEAGE.source, id: 'a'.repeat(4097) } }),
    ).toThrow();
    expect(() => parseProcessingProvenance({ ...LINEAGE, unknown: 'a'.repeat(4097) })).toThrow();
  });

  it('normalizes reversed JSON and JSONB keys, including nested model binding', () => {
    const reordered = {
      modelBinding: { sha256: modelBinding.sha256, resourceId: modelBinding.resourceId },
      output: { codec: LINEAGE.output.codec, frameCount: 30, fps: 29.97, height: 720, width: 1280 },
      input: { height: 360, width: 640 },
      source: { projectId: LINEAGE.source.projectId, id: LINEAGE.source.id, namespace: 'freecut-media' },
      variant: 'animation',
      evidence: 'client-reported',
      family: 'anime4k',
      version: 1,
    } as const;
    const input = { ...LINEAGE, modelBinding };
    expect(JSON.stringify(parseProcessingProvenance(JSON.parse(JSON.stringify(reordered))))).toBe(
      JSON.stringify(input),
    );
    const stored = bindProcessingProvenance(input, checksum);
    const fromJsonb = { outputSha256: checksum, ...reordered };
    expect(sameProvenance(stored, fromJsonb)).toBe(true);
    expect(() => assertReadyRetry(stored, fromJsonb)).not.toThrow();
  });

  it('compares persisted claims rather than only hashes', () => {
    const stored = bindProcessingProvenance(LINEAGE, checksum);
    expect(sameProvenance(null, null)).toBe(true);
    expect(sameProvenance(stored, null)).toBe(false);
    expect(sameProvenance(null, stored)).toBe(false);
    expect(sameProvenance(stored, { ...stored, outputSha256: 'cd'.repeat(32) })).toBe(false);
    for (const claim of [
      { ...LINEAGE, variant: 'threeD' },
      { ...LINEAGE, source: { ...LINEAGE.source, id: 'another-media' } },
      { ...LINEAGE, source: { ...LINEAGE.source, projectId: '0198a1c2-0000-7000-8000-0000000000bb' } },
      { ...LINEAGE, output: { ...LINEAGE.output, fps: 30 } },
      { ...LINEAGE, modelBinding },
    ]) {
      const supplied = bindProcessingProvenance(claim, checksum);
      expect(sameProvenance(stored, supplied)).toBe(false);
      expect(() => assertReadyRetry(stored, supplied)).toThrow('provenance_conflict');
    }
  });

  it('preserves legacy and ready rows on omitted provenance and refuses enrichment', () => {
    const stored = bindProcessingProvenance(LINEAGE, checksum);
    expect(() => assertReadyRetry(stored, undefined)).not.toThrow();
    expect(() => assertReadyRetry(null, undefined)).not.toThrow();
    expect(() => assertReadyRetry(stored, { ...stored })).not.toThrow();
    expect(() => assertReadyRetry(null, stored)).toThrow('provenance_conflict');
    expect(stored).toEqual({ ...LINEAGE, outputSha256: checksum });
  });

  it('refuses malformed persisted provenance rather than stripping it during comparison', () => {
    const stored = bindProcessingProvenance(LINEAGE, checksum);
    const malformed = { ...stored, source: { ...stored.source, unknown: true } };
    expect(() => sameProvenance(malformed, stored)).toThrow();
    expect(() => sameProvenance(stored, malformed)).toThrow();
  });
});
