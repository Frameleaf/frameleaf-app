// @vitest-environment node
import { describe, expect, it } from 'vite-plus/test';
import { zipSync } from 'fflate';
import { resolveLottieRenderSpec } from '@/infrastructure/lottie/lottie-text';
import { archiveFiles } from './lottie-archive-owned.fixture.mjs';

// Catches the native no-scope/no-edits shortcut omitting authored initialTheme.
// Actual Blob URL fetch + archive parser/projector; no renderer or fetch replacement.
describe('native authored archive theme without scoped resolver or explicit edits', () => {
  for (const version of ['1', '2']) {
    it(`v${version} prepares authored theme for the native renderer and preserves explicit precedence`, async () => {
      const bytes = zipSync(archiveFiles(version), { level: 0, mtime: new Date(2000, 0, 1) });
      const original = new Uint8Array(bytes);
      const src = URL.createObjectURL(new Blob([bytes], { type: 'application/lottie+json' }));
      const input = { mediaId: 'owned-local-vector', sourceWidth: 64, sourceHeight: 64 };
      const before = JSON.stringify(input);
      try {
        const native = await resolveLottieRenderSpec(src, input);
        expect(native.themeData).not.toBeNull();
        expect(JSON.parse(native.themeData!)).toEqual({
          rules: [
            { id: 'plateOpacity', type: 'Scalar', value: 25 },
            { id: 'plateScale', type: 'Vector', value: [100, 100] },
          ],
        });
        // Retain the existing raw-source/native autoResize renderer path.
        expect(native.data).toBeNull();
        expect(native.strict).toBeUndefined();
        expect(native.slots).toBeNull();
        const strict = await resolveLottieRenderSpec(src, input, { strict: true });
        expect(strict.themeData).toBe(native.themeData);
        expect(JSON.parse(strict.data!).layers[1].shapes[0].it[1].c.k).toEqual([1, 0, 0]);
        const explicit = await resolveLottieRenderSpec(src, { ...input, themeId: 'alternate' });
        expect(JSON.parse(explicit.themeData!)).toEqual({
          rules: [
            { id: 'plateOpacity', type: 'Scalar', value: 75 },
            { id: 'plateScale', type: 'Vector', value: [50, 100] },
          ],
        });
        expect(JSON.stringify(input)).toBe(before);
        expect(bytes).toEqual(original);
        expect(new Uint8Array(await (await fetch(src)).arrayBuffer())).toEqual(original);
      } finally {
        URL.revokeObjectURL(src);
      }
    });
  }
  it('leaves raw JSON without a theme on the ordinary native source path', async () => {
    const src = URL.createObjectURL(
      new Blob([JSON.stringify({ v: '5.7', w: 64, h: 64, fr: 30, ip: 0, op: 60, layers: [] })]),
    );
    try {
      expect(await resolveLottieRenderSpec(src, { sourceWidth: 64, sourceHeight: 64 })).toEqual({
        data: null,
        themeData: null,
        slots: null,
      });
    } finally {
      URL.revokeObjectURL(src);
    }
  });
});
