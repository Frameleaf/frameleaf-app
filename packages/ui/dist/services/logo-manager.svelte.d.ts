import { Theme, type LogoSet, type LogoVariants } from '../index.js';
declare class LogoManager {
    logos: LogoSet;
    getLogo(variant: LogoVariants, theme: Theme): string;
    setLogo(logos: LogoSet): void;
    resetLogos(): void;
}
export declare const logoManager: LogoManager;
export {};
