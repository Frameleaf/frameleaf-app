import futoDark from '../assets/immich-logo-futo-dark.svg';
import futoLight from '../assets/immich-logo-futo-light.svg';
import inlineDark from '../assets/immich-logo-inline-dark.svg';
import inlineLight from '../assets/immich-logo-inline-light.svg';
import stackedDark from '../assets/immich-logo-stacked-dark.svg';
import stackedLight from '../assets/immich-logo-stacked-light.svg';
import icon from '../assets/immich-logo.svg';
import { Theme } from '../index.js';
const defaultLogos = {
    stacked: {
        light: stackedLight,
        dark: stackedDark,
    },
    unstacked: {
        light: inlineLight,
        dark: inlineDark,
    },
    stacked_futo: {
        light: futoLight,
        dark: futoDark,
    },
    icon,
};
class LogoManager {
    logos = $state(defaultLogos);
    getLogo(variant, theme) {
        switch (variant) {
            case 'stacked': {
                return this.logos.stacked[theme];
            }
            case 'inline': {
                return this.logos.unstacked[theme];
            }
            case 'stacked-futo': {
                return this.logos.stacked_futo[theme];
            }
            default: {
                return this.logos.icon;
            }
        }
    }
    setLogo(logos) {
        this.logos = logos;
    }
    resetLogos() {
        this.logos = defaultLogos;
    }
}
export const logoManager = new LogoManager();
