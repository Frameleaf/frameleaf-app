import { MediaQuery } from 'svelte/reactivity';
import { fromStore } from 'svelte/store';
import { reduceMotion } from '$lib/stores/reduce-motion.store';

/** ACCOUNT-P3: "Use less movement" in Look & playback, on top of the device setting. */
const reduceMotionPreference = fromStore(reduceMotion);
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
  /** The device asks for less movement, or the person chose "Use less movement" on this device. */
  get reducedMotion() {
    return reducedMotion.current || reduceMotionPreference.current;
  },
  get wideInspector() {
    return wideInspector.current;
  },
};
