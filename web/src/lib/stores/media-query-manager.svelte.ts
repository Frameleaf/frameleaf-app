import { MediaQuery } from 'svelte/reactivity';

const pointerCoarse = new MediaQuery('pointer:coarse');
const maxMd = new MediaQuery('max-width: 767px');
const sidebar = new MediaQuery(`min-width: 850px`);
const reducedMotion = new MediaQuery('prefers-reduced-motion: reduce');
// The template opens Work's information panel by itself only above 1000px (`App.jsx` layout switch).
const wideInspector = new MediaQuery('min-width: 1001px');

export const mediaQueryManager = {
  get pointerCoarse() {
    return pointerCoarse.current;
  },
  get maxMd() {
    return maxMd.current;
  },
  get isFullSidebar() {
    return sidebar.current;
  },
  get reducedMotion() {
    return reducedMotion.current;
  },
  get wideInspector() {
    return wideInspector.current;
  },
};
