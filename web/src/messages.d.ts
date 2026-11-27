// FL-1797: the translated messages, split by language and part of the app (vite.config.ts).
// Its own file: a declaration beside app.d.ts's imports would only extend a module that exists.
declare module 'virtual:frameleaf-messages' {
  /** The route folders of each area; a route outside them needs only the `core` bundle. */
  export const areaRoutes: Record<string, string[]>;
  /** Languages whose bundles already hold English for the keys they lack. */
  export const merged: string[];
  /** By language file code, then bundle (`core`, an area, `rest`); a language has only the bundles it has messages for. */
  export const loaders: Record<string, Record<string, () => Promise<{ default: Record<string, string> }>>>;
}
