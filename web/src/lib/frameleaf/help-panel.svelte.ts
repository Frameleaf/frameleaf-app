/**
 * Whether the help panel (FL-489) is open. The top bar draws the panel; on phones its Help button
 * moves into the ☰ menu (UI review 2026-10-30 #8), so the rail opens it through this too.
 */
export const helpPanel = $state({ open: false });
