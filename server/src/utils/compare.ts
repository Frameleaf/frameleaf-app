/** Orders strings by UTF-16 code unit, the same order as `<`/`>` (not locale-aware). */
export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
