// Types for icon-packs.mjs, a Node build script outside the app's tsconfig (the spec imports it).
export type IconShape = string | { box?: number; fill?: string; strokes?: [width: number, path: string][] };

export interface IconPack {
  prefix: string;
  title: string;
  version: string;
  license: string;
  icons: Record<string, IconShape>;
}

export type IconPackNames = Record<string, { title: string; version: string; license: string; names: string[] }>;

export const shapeOf: (body: string, box: number) => IconShape | undefined;
export const buildIconPacks: () => IconPack[];
export const iconPackNames: () => IconPackNames;
export const readIconPackNames: () => IconPackNames;
