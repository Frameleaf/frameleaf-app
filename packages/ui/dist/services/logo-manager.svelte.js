import symbol from '../assets/frameleaf-symbol.svg';
import wordmark from '../assets/frameleaf-logo-dark.svg';

const lockup = { light: symbol, dark: wordmark };
const defaultLogos = { stacked: lockup, unstacked: lockup, icon: symbol };

class LogoManager {
  logos = $state(defaultLogos);

  getLogo(variant, theme) {
    if (variant === 'stacked') return this.logos.stacked[theme];
    if (variant === 'inline') return this.logos.unstacked[theme];
    return this.logos.icon;
  }

  setLogo(logos) {
    this.logos = logos;
  }

  resetLogos() {
    this.logos = defaultLogos;
  }
}
export const logoManager = new LogoManager();
