import type { KnownAssetDevelopRecipe } from 'src/dtos/asset-develop.dto.js';
import { LIGHTROOM_NAMESPACE, type XmpNode, settingsFor, xmpValue } from 'src/utils/develop-import/xmp.js';
import { normalizeDevelopRecipe } from 'src/utils/develop-recipe.js';

const channels = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function importLightroom(nodes: XmpNode[]): KnownAssetDevelopRecipe | undefined {
  const settings = Object.fromEntries(
    settingsFor(nodes, LIGHTROOM_NAMESPACE).map((node) => [node.name, xmpValue(node)]),
  );
  if (Object.keys(settings).length === 0) return;
  const value = (key: string): number | undefined => {
    const raw = settings[key];
    if (typeof raw !== 'string' || !raw.trim()) return;
    const result = Number(raw);
    return Number.isFinite(result) ? result : undefined;
  };
  const recipe: Partial<KnownAssetDevelopRecipe> & Record<string, unknown> = {};
  for (const [source, target] of Object.entries({
    Exposure2012: 'exposure',
    Contrast2012: 'contrast',
    Highlights2012: 'highlights',
    Shadows2012: 'shadows',
    Whites2012: 'whites',
    Blacks2012: 'blacks',
    Tint: 'tint',
    Vibrance: 'vibrance',
    Saturation: 'saturation',
    Clarity2012: 'clarity',
    Dehaze: 'dehaze',
  })) {
    const number = value(source);
    if (number !== undefined) recipe[target] = number;
  }
  const kelvin = value('Temperature');
  // Kelvin is approximated against daylight in reciprocal temperature, matching the warm/cool slider direction.
  if (kelvin !== undefined && kelvin > 0) recipe.temperature = clamp((1 / 5500 - 1 / kelvin) * 550_000, -100, 100);
  const vignette = value('PostCropVignetteAmount') ?? value('VignetteAmount');
  if (vignette !== undefined) recipe.vignette = -vignette;
  const left = value('CropLeft') ?? 0;
  const top = value('CropTop') ?? 0;
  const right = value('CropRight') ?? 1;
  const bottom = value('CropBottom') ?? 1;
  if (left >= 0 && top >= 0 && right <= 1 && bottom <= 1 && right > left && bottom > top)
    recipe.crop = { x: left, y: top, w: right - left, h: bottom - top };
  recipe.straighten = value('CropAngle') ?? 0;
  const rawCurve = settings.ToneCurvePV2012;
  const curve = (Array.isArray(rawCurve) ? rawCurve : [])
    .map((point) => point.split(',').map(Number))
    .filter((point) => point.length === 2 && point.every((value) => Number.isFinite(value)))
    .map(([x, y]) => ({ x: x / 255, y: y / 255 }));
  const validCurve =
    curve.length >= 2 &&
    curve.length <= 20 &&
    curve[0].x === 0 &&
    curve.at(-1)!.x === 1 &&
    curve.every(
      (point, i) =>
        point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 && (i === 0 || point.x - curve[i - 1].x >= 0.0025),
    );
  const hsl = channels.map((channel) => ({
    hue: clamp(value(`HueAdjustment${channel}`) ?? 0, -100, 100),
    saturation: clamp(value(`SaturationAdjustment${channel}`) ?? 0, -100, 100),
    luminance: clamp(value(`LuminanceAdjustment${channel}`) ?? 0, -100, 100),
  }));
  return {
    ...normalizeDevelopRecipe(recipe),
    imported: {
      lightroom: { ...settings, _xmp: settingsFor(nodes, LIGHTROOM_NAMESPACE) },
      ...(validCurve ? { curve } : {}),
      hsl,
    },
  };
}
