/**
 * The Studio chrome's motion, built from the shared vocabulary in `$lib/frameleaf/motion`
 * (BRAND.md): drawers arrive like a Sheet from the side, banners Reveal by sliding open so the
 * editor is not shoved in one frame, the opening screen fades into the editor, and the server
 * preview Pops from its corner. Every one is gated on Reduce Motion by the helper it wraps.
 */
import type { TransitionConfig } from 'svelte/transition';
import { motionFade, motionFly, motionSlide, pop, reveal, springEasing } from '$lib/frameleaf/motion';
import { DURATION, EXIT_DURATION } from '$lib/frameleaf/tokens';

/** Drawers sit on the inline end, so they travel from that side in either reading direction. */
const DRAWER_TRAVEL_PX = 24;
const drawerOffset = (node: Element) =>
  getComputedStyle(node).direction === 'rtl' ? -DRAWER_TRAVEL_PX : DRAWER_TRAVEL_PX;

export const drawerIn = (node: Element): TransitionConfig =>
  motionFly(node, { x: drawerOffset(node), duration: DURATION.spring, easing: springEasing });
export const drawerOut = (node: Element): TransitionConfig =>
  motionFly(node, { x: drawerOffset(node), duration: EXIT_DURATION.sheet });

export const bannerIn = (node: Element): TransitionConfig => motionSlide(node, { duration: DURATION.slow });
export const bannerOut = (node: Element): TransitionConfig => motionSlide(node, { duration: DURATION.base });

/** The opening or blocked screen giving way to the editor. */
export const overlayOut = (node: Element): TransitionConfig => motionFade(node, { duration: DURATION.slow });

export const popOut = (node: Element): TransitionConfig => pop(node, {}, { direction: 'out' });
export const revealOut = (node: Element): TransitionConfig => reveal(node, {}, { direction: 'out' });
