import type { KnownAssetDevelopRecipe } from 'src/dtos/asset-develop.dto.js';
import { DARKTABLE_NAMESPACE, type XmpNode, settingsFor } from 'src/utils/develop-import/xmp.js';
import { normalizeDevelopRecipe } from 'src/utils/develop-recipe.js';

/** Decodes only pinned native layouts; other modules remain in the imported envelope. */
export function importDarktable(nodes: XmpNode[]): KnownAssetDevelopRecipe | undefined {
  const history = settingsFor(nodes, DARKTABLE_NAMESPACE).find((node) => node.name === 'history');
  if (!history) return;
  const entries = (node: XmpNode): XmpNode[] =>
    node.name === 'li' ? [node] : node.children.flatMap((child) => entries(child));
  const recipe: Partial<KnownAssetDevelopRecipe> & Record<string, unknown> = {};
  for (const entry of entries(history)) {
    const fields = {
      ...entry.attributes,
      ...Object.fromEntries(entry.children.map((child) => [child.name, child.value.trim()])),
    };
    if (fields.enabled !== '1') continue;
    const hex = fields.params ?? '';
    if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) continue;
    const params = Buffer.from(hex, 'hex');
    const version = Number(fields.modversion);
    const number = (offset: number) => (offset + 4 <= params.length ? params.readFloatLE(offset) : NaN);
    // darktable 20891f6: exposure v7, temperature v4, crop v1 and clipping v5 (darktable-controls.ts).
    switch (fields.operation) {
      case 'exposure': {
        if (version === 7 && params.length === 28) recipe.exposure = number(8);
        break;
      }
      case 'temperature': {
        if (version === 4 && params.length === 20 && number(0) > 0 && number(8) > 0) {
          recipe.temperature = Math.log2(number(0) / number(8)) * 40;
          recipe.tint = Math.log2((number(0) + number(8)) / (2 * number(4))) * 40;
        }
        break;
      }
      case 'colorbalancergb': {
        // v5's first 32 floats are unchanged in v6. Perceptual controls are approximated on the quick renderer.
        if ([5, 6].includes(version) && params.length >= 132) {
          recipe.shadows = number(0) * 100;
          recipe.highlights = number(24) * 100;
          recipe.saturation = number(76) * 100;
          recipe.brilliance = number(96) * 100;
          recipe.vibrance = number(116) * 100;
          recipe.contrast = number(124) * 100;
        }
        break;
      }
      case 'crop':
      case 'clipping': {
        const offset = fields.operation === 'clipping' ? 4 : 0;
        if (
          (fields.operation === 'crop' && version === 1 && params.length === 24) ||
          (fields.operation === 'clipping' && version === 5 && params.length === 84)
        ) {
          const [left, top, right, bottom] = [offset, offset + 4, offset + 8, offset + 12].map((offset) =>
            number(offset),
          );
          if (left >= 0 && top >= 0 && right <= 1 && bottom <= 1 && right > left && bottom > top)
            recipe.crop = { x: left, y: top, w: right - left, h: bottom - top };
          if (offset) recipe.straighten = number(0);
        }
        break;
      }
      case 'ashift': {
        if (version === 5 && params.length === 892) {
          recipe.straighten = number(0);
          recipe.perspective = { vertical: number(4) * 100, horizontal: number(8) * 100 };
        }
        break;
      }
    }
  }
  return { ...normalizeDevelopRecipe(recipe), imported: { darktable: history } };
}
