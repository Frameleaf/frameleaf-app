import { defaults, getBaseUrl, type AssetDevelopRecipeDto } from '@frameleaf/sdk';

export type NativeTone = {
  exposureEV: number;
  shadows?: number;
  highlights?: number;
  saturation?: number;
  contrast?: number;
  curve?: { x: number; y: number }[];
};
export type NativeMask = {
  id: string;
  name: string | null;
  kind: 'radial' | 'linear' | 'brush' | 'subject' | 'sky' | 'background';
  coordinates: 'sensor-active';
  enabled: boolean;
  invert: boolean;
  amount: number;
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  endX: number;
  endY: number;
  feather: number;
  strokes?: { points: [number, number][]; radius: number; erase: boolean }[];
  artifact?: string;
  adjustments: NativeTone;
};
export type NativeRecipe = NativeTone & {
  version: 2;
  renderer: 'darktable/5.6.1';
  whiteBalance?: { red: number; green: number; blue: number };
  noiseThreshold?: number;
  sharpen?: { radius: number; amount: number; threshold: number };
  lensCorrection?: boolean;
  crop?: { x: number; y: number; w: number; h: number };
  rotation?: 0 | 90 | 180 | 270;
  straighten?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  sensorCanvas?: boolean;
  masks?: NativeMask[];
};
export const initialNativeRecipe = (): NativeRecipe => ({ version: 2, renderer: 'darktable/5.6.1', exposureEV: 0 });
export const isNativeRecipe = (value: AssetDevelopRecipeDto): value is AssetDevelopRecipeDto & NativeRecipe =>
  value.version === 2 && value.renderer === 'darktable/5.6.1';
export const nativePreset = (recipe: NativeRecipe): NativeRecipe => {
  const adjustments = { ...recipe };
  delete adjustments.crop;
  delete adjustments.rotation;
  delete adjustments.straighten;
  delete adjustments.flipHorizontal;
  delete adjustments.flipVertical;
  delete adjustments.sensorCanvas;
  return { ...adjustments, masks: recipe.masks?.filter((mask) => mask.kind === 'radial' || mask.kind === 'linear') };
};
export const newNativeMask = (kind: NativeMask['kind'], artifact?: string): NativeMask => ({
  id: crypto.randomUUID(),
  name: null,
  kind,
  coordinates: 'sensor-active',
  enabled: true,
  invert: false,
  amount: 100,
  x: 0.5,
  y: 0.5,
  radiusX: 0.25,
  radiusY: 0.25,
  endX: 0.5,
  endY: 1,
  feather: 50,
  ...(kind === 'brush' && { strokes: [] }),
  ...(artifact && { artifact }),
  adjustments: { exposureEV: 0 },
});

// SDK regeneration is an integration gate; use its configured transport and authentication meanwhile.
export async function proposeNativeMask(assetId: string, target: 'subject' | 'sky', signal?: AbortSignal) {
  const headers = new Headers(defaults.headers as HeadersInit);
  headers.set('Content-Type', 'application/json');
  const response = await (defaults.fetch ?? fetch)(
    `${getBaseUrl()}/assets/${encodeURIComponent(assetId)}/develop/masks/propose`,
    { method: 'POST', headers, credentials: 'include', signal, body: JSON.stringify({ target }) },
  );
  if (!response.ok) {
    throw new Error(
      `Subject/sky detection is unavailable (${response.status}). Draw a manual mask or check the local worker.`,
    );
  }
  return (await response.json()) as { id: string; width: number; height: number };
}
