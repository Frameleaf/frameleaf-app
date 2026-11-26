// Types for message-areas.mjs, a Node build script outside the app's tsconfig (vite.config.ts and the spec import it).
export const AREAS: Record<string, string[]>;
export const BUNDLES: string[];
export const flatten: (messages: object) => Record<string, string>;
export const analyse: (options: { src: string; keys: string[] }) => {
  areaOf: Record<string, string>;
  reached: Record<string, Set<string>>;
  literal: Map<string, Set<string>>;
};
export const languageCodes: (directory: string) => string[];
export const readLanguage: (directory: string, code: string) => Record<string, string>;
export const bundlesFor: (options: {
  code: string;
  own: Record<string, string>;
  en: Record<string, string>;
  areaOf?: Record<string, string>;
}) => { merged: boolean; bundles: Record<string, Record<string, string>> };
