/**
 * The browser and installed-app chrome colour (`<meta name="theme-color">`). It follows the
 * theme the app is actually showing, not the OS colour scheme, and matches that theme's canvas
 * so the chrome and the page meet without a seam (template/src/App.jsx:2193-2203, index.html:9;
 * design/frameleaf/tokens.json `dark.canvas` / `light.canvas`).
 */
export const FRAMELEAF_THEME_COLORS = { dark: '#101416', light: '#f4f6f7' } as const;

export const themeColor = (theme: 'dark' | 'light'): string => FRAMELEAF_THEME_COLORS[theme];
