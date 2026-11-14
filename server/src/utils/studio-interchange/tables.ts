/**
 * Mapping tables from other editors' names to Studio's (FL-1541). Data only: each reader story adds
 * its editor's rows. Transition presentations are ids of `studio/graph-parameters-v1.json`.
 * Names are matched without case or spaces, so "Cross Dissolve" and "crossdissolve" are the same row.
 */
import { InterchangeProject } from 'src/utils/studio-interchange/model.js';

type Source = InterchangeProject['source'];

/** Rows every editor shares: OpenTimelineIO's own names and the obvious ones. */
const COMMON_TRANSITIONS: Readonly<Record<string, string>> = {
  smptedissolve: 'dissolve',
  dissolve: 'dissolve',
  crossdissolve: 'dissolve',
  fade: 'fade',
  dip: 'dipToColorDissolve',
  diptoblack: 'dipToColorDissolve',
  diptowhite: 'dipToColorDissolve',
  fadetoblack: 'dipToColorDissolve',
  wipe: 'wipe',
  slide: 'slide',
  iris: 'iris',
  barndoor: 'barnDoor',
  clockwipe: 'clockWipe',
};

const EDITOR_TRANSITIONS: Readonly<Partial<Record<Source, Readonly<Record<string, string>>>>> = {
  premiere: {
    additivedissolve: 'additiveDissolve',
    filmdissolve: 'nonAdditiveDissolve',
    nonadditivedissolve: 'nonAdditiveDissolve',
    morphcut: 'smoothCut',
    centersplit: 'split',
    split: 'split',
    bandwipe: 'bandWipe',
    radialwipe: 'radialWipe',
    venetianblinds: 'venetianBlindWipe',
    irisround: 'ovalIris',
    irisbox: 'squareIris',
    irisdiamond: 'diamondIris',
    iriscross: 'crossIris',
  },
  resolve: {
    additivedissolve: 'additiveDissolve',
    blurdissolve: 'blurDissolve',
    nonadditivedissolve: 'nonAdditiveDissolve',
    smoothcut: 'smoothCut',
    centerwipe: 'centerWipe',
    edgewipe: 'edgeWipe',
    radialwipe: 'radialWipe',
    spiralwipe: 'spiralWipe',
    venetianblindwipe: 'venetianBlindWipe',
    xwipe: 'xWipe',
    bandwipe: 'bandWipe',
    arrowiris: 'arrowIris',
    crossiris: 'crossIris',
    diamondiris: 'diamondIris',
    eyeiris: 'eyeIris',
    hexagoniris: 'hexagonIris',
    ovaliris: 'ovalIris',
    pentagoniris: 'pentagonIris',
    squareiris: 'squareIris',
    triangleiris: 'triangleIris',
    heart: 'heartShape',
    star: 'starShape',
    box: 'boxShape',
  },
  finalcut: { flowtransition: 'smoothCut', blur: 'blurDissolve' },
  imovie: { crossblur: 'blurDissolve', fadethroughblack: 'dipToColorDissolve', fadethroughwhite: 'dipToColorDissolve' },
};

const normalise = (name: string) => name.toLowerCase().replaceAll(/[\s_-]+/g, '');

/** Studio's transition for an editor's name, or null when Studio has no match. */
export const studioTransitionFor = (source: Source, name: string): string | null => {
  const key = normalise(name);
  return EDITOR_TRANSITIONS[source]?.[key] ?? COMMON_TRANSITIONS[key] ?? null;
};

/** OpenTimelineIO's marker colour names to Studio's ruler colours. */
export const MARKER_COLOURS: Readonly<Record<string, string>> = {
  RED: '#EF4444',
  PINK: '#EC4899',
  ORANGE: '#F97316',
  YELLOW: '#EAB308',
  GREEN: '#22C55E',
  CYAN: '#06B6D4',
  BLUE: '#3B82F6',
  PURPLE: '#8B5CF6',
  MAGENTA: '#D946EF',
  BLACK: '#111827',
  WHITE: '#F9FAFB',
};
