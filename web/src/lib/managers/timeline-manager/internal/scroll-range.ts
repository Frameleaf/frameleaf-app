// Stay below the scroll-height limits of Chromium, Firefox and WebKit.
const MAX_TIMELINE_HEIGHT = 8_000_000;

export const physicalTimelineHeight = (height: number) => Math.min(MAX_TIMELINE_HEIGHT, Math.max(0, height));

export const toPhysicalScroll = (top: number, height: number, viewport: number) => {
  const logicalRange = Math.max(0, height - viewport);
  const physicalRange = Math.max(0, physicalTimelineHeight(height) - viewport);
  return logicalRange ? (Math.min(logicalRange, Math.max(0, top)) / logicalRange) * physicalRange : 0;
};

export const toTimelineScroll = (top: number, height: number, viewport: number) => {
  const logicalRange = Math.max(0, height - viewport);
  const physicalRange = Math.max(0, physicalTimelineHeight(height) - viewport);
  return physicalRange ? (Math.min(physicalRange, Math.max(0, top)) / physicalRange) * logicalRange : 0;
};
