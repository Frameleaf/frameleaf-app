import { Theme, ThemePreference } from '../types.js';
declare class ThemeManager {
    #private;
    get prefersDark(): boolean;
    get preference(): ThemePreference;
    get value(): Theme;
    constructor();
    toggle(): void;
    setPreference(preference: ThemePreference): void;
}
export declare const themeManager: ThemeManager;
export {};
